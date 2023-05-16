export interface FieldList {
	include?: [string];
	exclude?: [string];
}
export interface DirectiveArgs {
	fields?: FieldList;
	settings?: string;
}
