import { DirectiveWrapper, InvalidDirectiveError, TransformerPluginBase } from '@aws-amplify/graphql-transformer-core';
import {
	StackManagerProvider,
	TransformerContextProvider,
	TransformerPluginProvider,
	TransformerSchemaVisitStepContextProvider,
	TransformerTransformSchemaStepContextProvider,
} from '@aws-amplify/graphql-transformer-interfaces';
import { Schema, SearchableType } from '@orama/orama';
import { CfnCondition, CfnParameter, Fn, Stack } from 'aws-cdk-lib';
import { CfnResolver, DynamoDbDataSource } from 'aws-cdk-lib/aws-appsync';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { IConstruct } from 'constructs';
import { DirectiveNode, EnumTypeDefinitionNode, ObjectTypeDefinitionNode, TypeNode } from 'graphql';
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
import { createDBOnS3, createS3Bucket } from './cdk/create_db_bucket';
import { createEventSourceMapping, createLambda, createLambdaRole } from './cdk/create_streaming_lambda';
import { DirectiveArgs, GRAPHQL_TYPES_TO_VALID_TYPES, VALID_SCHEMA_TYPES } from './directive-args';

const STACK_NAME = 'OramaStack';
const directiveName = 'oramaSearchable';
const RESPONSE_MAPPING_TEMPLATE = `
#if( $context.error )
  $util.error($context.error.message, $context.error.type)
#else
  $util.toJson($context.result)
#end
`;

interface SearchableObjectTypeDefinition {
	node: ObjectTypeDefinitionNode;
	fieldName: string;
	entity: string;
	directiveArguments: DirectiveArgs;
	schema: Schema | undefined;
}

export class OramaSearchableTransformer extends TransformerPluginBase implements TransformerPluginProvider {
	searchableObjectTypeDefinitions: SearchableObjectTypeDefinition[];
	stasck: Stack | undefined;

	constructor() {
		super(
			'OramaSearchableTransformer',
			`
		directive @${directiveName}(schema: AWSJSON) on OBJECT
		`
		);
		this.searchableObjectTypeDefinitions = [];
		this.stasck = undefined;
	}

	private getStack(stackManager: StackManagerProvider) {
		if (!this.stasck) {
			this.stasck = stackManager.createStack(STACK_NAME);
		}
		return this.stasck;
	}

	/**
	 * generate resolvers
	 */
	generateResolvers(context: TransformerContextProvider) {
		const { Env } = ResourceConstants.PARAMETERS;
		const { HasEnvironmentParameter } = ResourceConstants.CONDITIONS;
		const stack = this.getStack(context.stackManager);
		const envParam = context.stackManager.getParameter(Env) as CfnParameter;

		new CfnCondition(stack, HasEnvironmentParameter, {
			expression: Fn.conditionNot(Fn.conditionEquals(envParam, ResourceConstants.NONE)),
		});

		// create a bucket for each env that will store the DB file
		const bucket = createS3Bucket(stack);

		const searchLambda = generateLambda(context, stack, 'search');
		const triggerLambda = generateLambda(context, stack, 'trigger');

		for (const definition of this.searchableObjectTypeDefinitions) {
			const typeName = context.output.getQueryTypeName();
			const table = getTable(context, definition.node);
			const ddbTable = table as Table;

			if (!ddbTable) {
				throw new Error(`Failed to find ddb table for @${directiveName} on field ${definition.entity}`);
			}

			if (definition.schema === undefined)
				console.warn(`No schema found for @oramaSearchable on entity  ${definition.entity}`);
			else createDBOnS3(stack, bucket, definition.fieldName, definition.schema);

			bucket.grantRead(searchLambda.lambdaRole);

			// creates event source mapping from ddb to lambda
			if (!ddbTable.tableStreamArn) {
				throw new Error('tableStreamArn is required on ddb table ot create event source mappings');
			}

			createEventSourceMapping(
				stack,
				`eventSourceMapping-${definition.entity}`,
				triggerLambda.lambda,
				ddbTable.tableStreamArn
			);

			ddbTable.grantStreamRead(triggerLambda.lambdaRole);
			bucket.grantReadWrite(triggerLambda.lambdaRole);

			if (!typeName) {
				throw new Error('Query type name not found');
			}

			// Connect the resolver to the API
			const resolver = new CfnResolver(stack, `${definition.entity}SearchResolver`, {
				apiId: context.api.apiId,
				fieldName: definition.fieldName,
				typeName: 'Query',
				// kind: 'UNIT',
				dataSourceName: searchLambda.lambdaDataSource.ds.attrName,
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
	object(definition: ObjectTypeDefinitionNode, directive: DirectiveNode) {
		validateModelDirective(definition);
		const directiveArguments = getDirectiveArguments(directive);
		validateSchemaFields(directiveArguments.schema, definition);
		const fieldName = graphqlName(`search${plurality(toUpper(definition.name.value), true)}`);
		this.searchableObjectTypeDefinitions.push({
			node: definition,
			fieldName,
			entity: definition.name.value,
			directiveArguments,
			schema: undefined,
		});
	}

	/**
	 * Update the schema with additional queries and input types
	 */
	transformSchema(context: TransformerTransformSchemaStepContextProvider) {
		// For each model that has been annotated with @oramaSearchable

		const fields = this.searchableObjectTypeDefinitions.map(({ fieldName, entity }) => {
			const field = {
				name: fieldName,
				args: [
					/* term */
					makeInputValueDefinition('term', makeNamedType('String')),
					/* limit */
					makeInputValueDefinition('limit', makeNamedType('Int')),
				],
				type: makeNonNullType(makeListType(makeNamedType(entity))),
			};
			return makeField(field.name, field.args, field.type);
		});
		context.output.addQueryFields(fields);
	}

	/**
	 *  Validate the schema after individual transformers finishes parsing the AST
	 */
	validate(context: TransformerSchemaVisitStepContextProvider) {
		const { inputDocument } = context;
		const customObjectTypes = inputDocument.definitions.filter(
			({ kind }) => kind === 'ObjectTypeDefinition'
		) as ObjectTypeDefinitionNode[];

		const customEnumTypes = inputDocument.definitions.filter(
			({ kind }) => kind === 'EnumTypeDefinition'
		) as EnumTypeDefinitionNode[];

		const visitedTypes = new Map<string, Record<string, string> | string[]>();

		let index = 0;
		for (const { directiveArguments } of this.searchableObjectTypeDefinitions) {
			const notFoundSchemaTypes = getNonValidSchemaType(directiveArguments);

			while (notFoundSchemaTypes.length > 0) {
				const notFoundType = notFoundSchemaTypes.shift();
				if (notFoundType === undefined) {
					throw new Error('notFoundType is undefined');
				}
				if (visitedTypes.has(notFoundType)) {
					throw new InvalidDirectiveError(`Circular reference detected for type ${notFoundType}`);
				}
				const correctObject = customObjectTypes.find(({ name }) => name.value === notFoundType);

				if (correctObject !== undefined) {
					// found
					const fields = [];
					const tmp: Record<string, string> = {};
					for (const field of correctObject.fields ?? []) {
						const { type, validType } = getCorrectType(field.type);
						if (validType === undefined) fields.push(type);
						tmp[field.name.value] = validType ?? type;
					}
					visitedTypes.set(notFoundType, tmp);
					notFoundSchemaTypes.push(...fields);
				} else {
					// not found on objects, search into enums
					const correctEnum = customEnumTypes.find(({ name }) => name.value === notFoundType);
					if (correctEnum === undefined) {
						throw new InvalidDirectiveError(`${notFoundType} not found in schema`);
					} else {
						visitedTypes.set(notFoundType, correctEnum.values?.map(({ name }) => name.value) ?? []);
					}
				}
			}
			// now that all types are found, complete the schema
			const schema: Schema = {};
			for (const [schemaField, schemaType] of Object.entries(directiveArguments.schema)) {
				schema[schemaField] = getSchema(schemaType, visitedTypes);
			}
			// schema is ready
			this.searchableObjectTypeDefinitions[index].schema = schema;
			index++;
		}
	}
}

const getSchema = (
	schemaType: string,
	visitedTypes: Map<string, Record<string, string> | string[]>
): SearchableType | Schema => {
	if (VALID_SCHEMA_TYPES.includes(schemaType)) {
		return schemaType as SearchableType;
	}
	const value = visitedTypes.get(schemaType);

	if (value === undefined) {
		throw new InvalidDirectiveError(`The schema type ${schemaType} is not supported`);
	}

	if (Array.isArray(value)) {
		// handling enum
		return 'string';
	}

	// it is an object
	const schema: Schema = {};
	for (const [field, type] of Object.entries(value)) {
		schema[field] = getSchema(type, visitedTypes);
	}
	return schema;
};

const getNonValidSchemaType = ({ schema }: DirectiveArgs) => {
	return Object.values(schema)
		.map((schemaValue) => {
			const type = typeof schemaValue;
			switch (type) {
				case 'string':
					return schemaValue;
				case 'object':
					return type;
				default:
					throw new InvalidDirectiveError(`The schema type ${type} is not supported`);
			}
		})
		.filter((value) => !VALID_SCHEMA_TYPES.includes(value));
};

const getValidSchemaType = (type: string) => GRAPHQL_TYPES_TO_VALID_TYPES[type];

const getCorrectType = (node: TypeNode, fn = getValidSchemaType): { validType: string | undefined; type: string } => {
	while (node.kind !== 'NamedType') node = node.type;

	const type = node.name.value;
	return { validType: fn(type), type };
};

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
	const directiveWrapped = new DirectiveWrapper(directive);
	const directiveArguments: DirectiveArgs = directiveWrapped.getArguments({
		schema: {},
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
	$util.toJson({	
		"version": "2018-05-29", 
		"operation": "Invoke", 
		"payload": { 
			"typeName": "Query", 
			"tableName": "${tableName}", 
			"arguments": $context.arguments,
			"selectionSetList": $utils.toJson($context.info.selectionSetList)
		}
	})
`;

const validateSchemaFields = (schema: Record<string, string>, definition: ObjectTypeDefinitionNode) => {
	Object.keys(schema).forEach((key) => {
		if (!definition.fields?.map((el) => el.name.value).includes(key))
			throw new InvalidDirectiveError(`${key} is not a valid field of ${definition.name.value}`);
	});
};

const generateLambda = (context: TransformerContextProvider, stack: Stack, type: string) => {
	// streaming lambda role
	const lambdaRole = createLambdaRole(context, stack, type);

	// creates lambda
	const lambda = createLambda(stack, lambdaRole, type, context.api);

	// add lambda as data source for the search queries
	const lambdaDataSource = context.api.host.addLambdaDataSource(`${type}ResolverDataSource`, lambda, {}, stack);
	return {
		lambdaRole,
		lambda,
		lambdaDataSource,
	};
};
