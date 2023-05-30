import { S3MappingFunctionCode } from '@aws-amplify/graphql-transformer-core/lib/cdk-compat/template-asset';
import { GraphQLAPIProvider, TransformerContextProvider } from '@aws-amplify/graphql-transformer-interfaces';
import { Stack } from 'aws-cdk-lib';
import { Effect, IRole, Policy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnFunction, EventSourceMapping, IFunction, Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { resolve } from 'path';

export function createLambdaRole(context: TransformerContextProvider, stack: Construct, prefix: string): IRole {
	const role = new Role(stack, prefix + 'OramaLambdaRole', {
		assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
		roleName: context.resourceHelper.generateIAMRoleName(prefix + 'OramaRole'),
	});

	role.attachInlinePolicy(
		new Policy(stack, prefix + 'CloudwatchLogsAccess', {
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

export const createLambda = (stack: Stack, lambdaRole: IRole, prefix: string, api: GraphQLAPIProvider): IFunction => {
	// eslint-disable-next-line no-constant-condition
	if (false) {
		const filePath = resolve(__dirname, '..', '..', 'lambdas', prefix, 'index.ts');
		const functionKey = prefix + 'OramaFunction',
			fn = new NodejsFunction(stack, functionKey, {
				entry: filePath,
				handler: 'handler',
				role: lambdaRole,
				runtime: Runtime.NODEJS_18_X,
				depsLockFilePath: resolve(__dirname, '..', '..', 'package-lock.json'),
			});

		const functionCode = new S3MappingFunctionCode(functionKey, filePath).bind(fn);
		(fn.node.defaultChild as CfnFunction).code = {
			s3Key: functionCode.s3ObjectKey,
			s3Bucket: functionCode.s3BucketName,
		};
		return fn;
	}

	const runtime = Runtime.NODEJS_18_X;
	const filePath = resolve(__dirname, '..', '..', 'build', prefix + '.zip');

	const functionName = prefix + 'OramaFunction',
		functionKey = `functions/${functionName}.zip`,
		handlerName = 'handler',
		layers = undefined,
		role = lambdaRole,
		environment: { [key: string]: string } = {},
		timeout = undefined;

	return api.host.addLambdaFunction(
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
