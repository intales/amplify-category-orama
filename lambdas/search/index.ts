import { Context } from 'aws-lambda';

type SearchEvent = {
	arguments: { term: string; limit: number };
	typeName: 'Query';
	tableName: string;
	selectionSetList: string[];
};

export const handler = async (event: SearchEvent, context: Context) => {
	return [];
};
