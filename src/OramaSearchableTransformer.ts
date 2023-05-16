import { DirectiveWrapper, InvalidDirectiveError, TransformerPluginBase } from '@aws-amplify/graphql-transformer-core';
import {
	TransformerContextProvider,
	TransformerSchemaVisitStepContextProvider,
} from '@aws-amplify/graphql-transformer-interfaces';
import { CfnCondition, CfnParameter, Fn } from 'aws-cdk-lib';
import { DynamoDbDataSource } from 'aws-cdk-lib/aws-appsync';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { IConstruct } from 'constructs';
import { DirectiveNode, ObjectTypeDefinitionNode } from 'graphql';
import { ModelResourceIDs, ResourceConstants, graphqlName, plurality, toUpper } from 'graphql-transformer-common';
import { createLambda, createLambdaRole } from './cdk/create_streaming_lambda';
import { DirectiveArgs } from './directive-args';

const STACK_NAME = 'OramaStack';
const directiveName = 'oramaSearchable';

interface SearchableObjectTypeDefinition {
	node: ObjectTypeDefinitionNode;
	fieldName: string;
	fieldNameRaw: string;
	directiveArguments: DirectiveArgs;
}

export class OramaSearchableTransformer extends TransformerPluginBase {
	searchableObjectTypeDefinitions: SearchableObjectTypeDefinition[];

	constructor() {
		super(
			'OramaSearchableTransformer',
			/* GraphQL */ `
      directive @${directiveName} on OBJECT
    `
		);
		this.searchableObjectTypeDefinitions = [];
	}

	generateResolvers(context: TransformerContextProvider) {
		const { Env } = ResourceConstants.PARAMETERS;
		const { HasEnvironmentParameter } = ResourceConstants.CONDITIONS;
		const stack = context.stackManager.createStack(STACK_NAME);

		const envParam = context.stackManager.getParameter(Env) as CfnParameter;
		// eslint-disable-next-line no-new
		new CfnCondition(stack, HasEnvironmentParameter, {
			expression: Fn.conditionNot(Fn.conditionEquals(envParam, ResourceConstants.NONE)),
		});

		// streaming lambda role
		const lambdaRole = createLambdaRole(context, stack);

		// creates algolia lambda
		const lambda = createLambda(stack, context.api, lambdaRole, Env);

		for (const definition of this.searchableObjectTypeDefinitions) {
			//const type = definition.node.name.value;
			const fields = definition.node.fields?.map((f) => f.name.value) ?? [];
			const typeName = context.output.getQueryTypeName();
			const table = getTable(context, definition.node);
			const ddbTable = table as Table;

			if (!ddbTable) {
				throw new Error(`Failed to find ddb table for @${directiveName} on field ${definition.fieldNameRaw}`);
			}
			// creates event source mapping from ddb to lambda
			if (!ddbTable.tableStreamArn) {
				throw new Error('tableStreamArn is required on ddb table ot create event source mappings');
			}

			ddbTable.grantStreamRead(lambdaRole);

			if (!typeName) {
				throw new Error('Query type name not found');
			}
		}
	}

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
}

const validateModelDirective = (definition: ObjectTypeDefinitionNode): void => {
	const modelDirective = definition?.directives?.find((dir) => dir.name.value === 'model');
	if (!modelDirective) {
		throw new InvalidDirectiveError(`Types annotated with @${directiveName} must also be annotated with @model.`);
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
