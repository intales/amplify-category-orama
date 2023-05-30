import { Schema } from '@orama/orama';
import { BlockPublicAccess, Bucket, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export function createS3Bucket(stack: Construct) {
	const s3Bucket = new Bucket(stack, `oramasearch-bucket`, {
		objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
		blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
	});

	return s3Bucket;
}

export function createDBOnS3(stack: Construct, s3Bucket: Bucket, entity: string, schema: Schema) {
	const s3BucketDeployment = new BucketDeployment(stack, `${entity}DatabaseDeploy`, {
		sources: [Source.jsonData(`${entity}-db.json`, schema)],
		destinationBucket: s3Bucket,
		destinationKeyPrefix: '/',
	});
	return s3BucketDeployment;
}
