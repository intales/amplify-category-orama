import { ModelTransformer } from '@aws-amplify/graphql-model-transformer';
import { GraphQLTransform } from '@aws-amplify/graphql-transformer-core';
import { parse } from 'graphql';

import { OramaSearchableTransformer } from '../OramaSearchableTransformer';

test('OramaSearchableTransformer validation should throw a schema validation error if type is not found on schema', () => {
	const validSchema = `
      type Post @model @oramaSearchable(schema: {
		id: string,
		avatar: S3Object
	  }) {
          id: ID!
          title: String!
          createdAt: String
          updatedAt: String,
		  avatar: S3Object
      }
      `;
	const transformer = new GraphQLTransform({
		transformers: [new ModelTransformer(), new OramaSearchableTransformer()],
	});
	expect(() => transformer.transform(validSchema)).toThrow(/Schema validation failed./);
});
test('OramaSearchableTransformer validation should throw a schema validation error if more than one type is found on schema', () => {
	const validSchema = `
      type Post @model @oramaSearchable(schema: {
		id: string,
		avatar: S3Object
	  }) {
          id: ID!
          title: String!
          createdAt: String
          updatedAt: String,
		  avatar: S3Object,
      }

	  type S3Object { 
		  bucket: String!,
	  }
	  
	  type S3Object { 
		  region: String!,
	  }
      `;
	const transformer = new GraphQLTransform({
		transformers: [new ModelTransformer(), new OramaSearchableTransformer()],
	});
	expect(() => transformer.transform(validSchema)).toThrow(/Schema validation failed./);
});
test('OramaSearchableTransformer validation happy case', () => {
	const validSchema = `
      type Post @model @oramaSearchable(schema: {
		id: string,
		picture: S3Object
	  }) {
		id: ID!
		title: String!
		updatedAt: AWSDateTime!
		createdAt: AWSDateTime!
		picture: S3Object,
      }

	  enum S3Accesslevel { private, public }

	  type S3Object { 
		bucket: String!,
		region: String!,
		key: String!,
		accessLevel: S3Accesslevel!,
		uselessType: YetAnotherType
	  }

	  type YetAnotherType {
		index: Int,
		uselessType: Float,
	  }

	  type User  @model @oramaSearchable(schema: {
		id: string,
	  }){
		id: ID!,
		posts: [Post],
	  }

      `;
	const transformer = new GraphQLTransform({
		transformers: [new ModelTransformer(), new OramaSearchableTransformer()],
	});
	const out = transformer.transform(validSchema);
	expect(out).toBeDefined();
	parse(out.schema);
});
