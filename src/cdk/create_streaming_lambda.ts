import { GraphQLAPIProvider, TransformerContextProvider } from '@aws-amplify/graphql-transformer-interfaces';
import { Stack } from 'aws-cdk-lib';
import { Effect, IRole, Policy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { EventSourceMapping, IFunction, ILayerVersion, Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { resolve } from 'path';

const ID = 'OramaFunctionID';
const ZIP_PATH = ['build', 'handler.zip'];

export function createLambdaRole(context: TransformerContextProvider, stack: Construct): IRole {
	const role = new Role(stack, 'OramaLambdaRole', {
		assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
		roleName: context.resourceHelper.generateIAMRoleName('OramaIAMRole'),
	});

	role.attachInlinePolicy(
		new Policy(stack, 'CloudwatchLogsAccess', {
			statements: [
				new PolicyStatement({
					actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
					effect: Effect.ALLOW,
					resources: ['arn:aws:logs:*:*:*'],
				}),
			],
		})
	);

	return role;
}

export const createLambda = (
	stack: Stack,
	apiGraphql: GraphQLAPIProvider,
	lambdaRole: IRole,
	env: string
): IFunction => {
	const filePath = resolve(__dirname, '..', '..', ...ZIP_PATH),
		runtime = Runtime.NODEJS_18_X;

	const functionName = 'OramaFunction',
		functionKey = `functions/${ID}-${env}.zip`,
		handlerName = 'handler',
		layers: ILayerVersion[] = [],
		role = lambdaRole,
		environment: { [key: string]: string } = {},
		timeout = undefined;

	return apiGraphql.host.addLambdaFunction(
		functionName,
		functionKey,
		handlerName,
		filePath,
		runtime,
		layers,
		role,
		environment,
		timeout,
		stack
	);
};

export const createEventSourceMapping = (stack: Construct, type: string, target: IFunction, tableStreamArn: string) => {
	return new EventSourceMapping(stack, type, {
		eventSourceArn: tableStreamArn,
		target,
		enabled: true,
		startingPosition: StartingPosition.LATEST,
	});
};
