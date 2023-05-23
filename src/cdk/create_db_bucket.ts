import { BlockPublicAccess, Bucket, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export function createS3Bucket(stack: Construct, env: string) {
	const s3Bucket = new Bucket(stack, `oramasearch-bucket-${env}`, {
		objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
		blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
	});

	return s3Bucket;
}

export function createDBOnS3(stack: Construct, s3Bucket: Bucket, entity: string, env: string) {
	const s3BucketDeployment = new BucketDeployment(stack, `${entity}DatabaseDeploy`, {
		sources: [Source.jsonData(`${entity}-db-${env}.json`, { index: [1, 2] })],
		destinationBucket: s3Bucket,
		destinationKeyPrefix: '/',
	});
	return s3BucketDeployment;
}
