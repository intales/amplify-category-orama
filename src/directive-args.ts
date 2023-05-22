// export interface FieldList {
// 	include?: [string];
// 	exclude?: [string];
// }

export const GRAPHQL_TYPES_TO_VALID_TYPES: Record<string, string | undefined> = {
	String: 'string',
	Int: 'number',
	Float: 'number',
	Boolean: 'boolean',
};

export const VALID_SCHEMA_TYPES = Object.values(GRAPHQL_TYPES_TO_VALID_TYPES) as string[];

export interface DirectiveArgs {
	schema: Record<string, string>;
}
