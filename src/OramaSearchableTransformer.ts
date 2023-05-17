import { DirectiveWrapper, InvalidDirectiveError, TransformerPluginBase } from '@aws-amplify/graphql-transformer-core';
import {
	TransformerContextProvider,
	TransformerSchemaVisitStepContextProvider,
	TransformerTransformSchemaStepContextProvider,
} from '@aws-amplify/graphql-transformer-interfaces';
import { CfnCondition, CfnParameter, Fn } from 'aws-cdk-lib';
import { CfnResolver, DynamoDbDataSource } from 'aws-cdk-lib/aws-appsync';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { IConstruct } from 'constructs';
import { DirectiveNode, ObjectTypeDefinitionNode } from 'graphql';
import {
	ModelResourceIDs,
	ResourceConstants,
	graphqlName,
	makeField,
	makeInputValueDefinition,
	makeListType,
	makeNamedType,
	makeNonNullType,
	plurality,
	toUpper,
} from 'graphql-transformer-common';
import { createEventSourceMapping, createLambda, createLambdaRole } from './cdk/create_streaming_lambda';
import { DirectiveArgs } from './directive-args';

const STACK_NAME = 'OramaStack';
const directiveName = 'oramaSearchable';
const RESPONSE_MAPPING_TEMPLATE = `
#if( $ctx.error )
  $util.error($ctx.error.message, $ctx.error.type)
#else
  $util.parseJson($ctx.result)
#end
`;

interface SearchableObjectTypeDefinition {
	node: ObjectTypeDefinitionNode;
	fieldName: string;
	fieldNameRaw: string;
	directiveArguments: DirectiveArgs;
}

export class OramaSearchableTransformer extends TransformerPluginBase {
	searchableObjectTypeDefinitions: SearchableObjectTypeDefinition[];

	constructor() {
		super('OramaSearchableTransformer', `directive @${directiveName} on OBJECT`);
		this.searchableObjectTypeDefinitions = [];
	}

	/**
	 * generate resolvers
	 */
	generateResolvers(context: TransformerContextProvider) {
		const { Env } = ResourceConstants.PARAMETERS;
		const { HasEnvironmentParameter } = ResourceConstants.CONDITIONS;
		const stack = context.stackManager.createStack(STACK_NAME);

		const envParam = context.stackManager.getParameter(Env) as CfnParameter;

		new CfnCondition(stack, HasEnvironmentParameter, {
			expression: Fn.conditionNot(Fn.conditionEquals(envParam, ResourceConstants.NONE)),
		});

		stack.templateOptions.description = 'An auto-generated nested stack for orama search.';
		stack.templateOptions.templateFormatVersion = '2010-09-09';

		// streaming lambda role
		const lambdaRole = createLambdaRole(context, stack);

		// creates algolia lambda
		const lambda = createLambda(stack, context.api, lambdaRole, Env);

		// add lambda as data source for the search queries
		const lambdaDataSource = context.api.host.addLambdaDataSource(`searchResolverDataSource`, lambda, {}, stack);

		for (const definition of this.searchableObjectTypeDefinitions) {
			const typeName = context.output.getQueryTypeName();
			const table = getTable(context, definition.node);
			const ddbTable = table as Table;

			if (!ddbTable) {
				throw new Error(`Failed to find ddb table for @${directiveName} on field ${definition.fieldNameRaw}`);
			}

			ddbTable.grantStreamRead(lambdaRole);

			// creates event source mapping from ddb to lambda
			if (!ddbTable.tableStreamArn) {
				throw new Error('tableStreamArn is required on ddb table ot create event source mappings');
			}

			createEventSourceMapping(
				stack,
				`eventSourceMapping-${definition.fieldNameRaw}-${Env}`,
				lambda,
				ddbTable.tableStreamArn
			);

			if (!typeName) {
				throw new Error('Query type name not found');
			}
			// Connect the resolver to the API
			const resolver = new CfnResolver(stack, `${definition.fieldNameRaw}SearchResolver`, {
				apiId: context.api.apiId,
				fieldName: definition.fieldName,
				typeName: 'Query',
				// kind: 'UNIT',
				dataSourceName: lambdaDataSource.ds.attrName,
				requestMappingTemplate: getRequestMappingTemplate(ddbTable.tableName),
				responseMappingTemplate: RESPONSE_MAPPING_TEMPLATE,
			});

			context.api.addSchemaDependency(resolver);
		}
	}

	/**
	 * A transformer implements a single function per location that its directive can be applied.
	 * This method handles transforming directives on objects type definitions. This includes type
	 * extensions.
	 */
	object(
		definition: ObjectTypeDefinitionNode,
		directive: DirectiveNode,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		_ctx: TransformerSchemaVisitStepContextProvider
	) {
		validateModelDirective(definition);
		const directiveArguments = getDirectiveArguments(directive);
		const fieldName = graphqlName(`search${plurality(toUpper(definition.name.value), true)}`);
		this.searchableObjectTypeDefinitions.push({
			node: definition,
			fieldName,
			fieldNameRaw: definition.name.value,
			directiveArguments,
		});
	}

	/**
	 * Update the schema with additional queries and input types
	 */
	transformSchema(context: TransformerTransformSchemaStepContextProvider) {
		// For each model that has been annotated with @oramaSearchable
		const fields = this.searchableObjectTypeDefinitions.map(({ fieldName, fieldNameRaw }) => {
			// Add the search query field to the schema
			// e.g. searchBlogs(query: String): AWSJSON

			const field = {
				name: fieldName,
				args: [
					/* term */
					makeInputValueDefinition('term', makeNamedType('String')),
					/* limit */
					makeInputValueDefinition('limit', makeNamedType('Int')),
				],
				type: makeNonNullType(makeListType(makeNamedType(fieldNameRaw))),
			};
			return makeField(field.name, field.args, field.type);
		});
		context.output.addQueryFields(fields);
	}
}

const validateModelDirective = (definition: ObjectTypeDefinitionNode): void => {
	const values = definition.directives?.map(({ name }) => name.value);
	if (values === undefined || !values.includes('model')) {
		throw new InvalidDirectiveError(`Types annotated with @${directiveName} must also be annotated with @model.`);
	}

	const modelIndex = values.indexOf('model');
	const oramaSearchableIndex = values.indexOf(directiveName);
	if (modelIndex + 1 !== oramaSearchableIndex) {
		throw new InvalidDirectiveError(`@${directiveName} must be positionated next to @model`);
	}
};

const getDirectiveArguments = (directive: DirectiveNode): DirectiveArgs => {
	const directiveWrapped = new DirectiveWrapper(directive as ConstructorParameters<typeof DirectiveWrapper>[0]);
	const directiveArguments: DirectiveArgs = directiveWrapped.getArguments({
		fields: undefined,
		settings: undefined,
	});
	return directiveArguments;
};

const getTable = (context: TransformerContextProvider, definition: ObjectTypeDefinitionNode): IConstruct => {
	type InterfaceTypeDefinitionNode = Parameters<typeof context.dataSources.get>[0];
	const ddbDataSource = context.dataSources.get(definition as InterfaceTypeDefinitionNode) as DynamoDbDataSource;
	const tableName = ModelResourceIDs.ModelTableResourceID(definition.name.value);
	const table = ddbDataSource.ds.stack.node.findChild(tableName);
	return table;
};

const getRequestMappingTemplate = (tableName: string) => /* VTL */ `
$util.toJson({ "version": "2018-05-29", "operation": "Invoke", "payload": $util.toJson({ "typeName": "Query", "tableName": "${tableName}", "arguments": $util.toJson($ctx.args) }) })
`;
