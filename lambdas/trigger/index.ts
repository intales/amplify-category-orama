import { DynamoDBStreamEvent } from 'aws-lambda';

export const handler = (event: DynamoDBStreamEvent) => {
	console.log(event);
};
