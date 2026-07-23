import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const OptionalStringArray = Schema.Array(TrimmedNonEmptyString).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);

export const AcpRegistryPackageDistribution = Schema.Struct({
  package: TrimmedNonEmptyString,
  args: Schema.optional(OptionalStringArray),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type AcpRegistryPackageDistribution = typeof AcpRegistryPackageDistribution.Type;

export const AcpRegistryBinaryDistribution = Schema.Struct({
  archive: TrimmedNonEmptyString,
  cmd: TrimmedNonEmptyString,
  args: Schema.optional(OptionalStringArray),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  sha256: Schema.optional(TrimmedNonEmptyString),
});
export type AcpRegistryBinaryDistribution = typeof AcpRegistryBinaryDistribution.Type;

export const AcpRegistryAgent = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  repository: Schema.optional(TrimmedNonEmptyString),
  website: Schema.optional(TrimmedNonEmptyString),
  authors: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  license: Schema.optional(TrimmedNonEmptyString),
  icon: Schema.optional(TrimmedNonEmptyString),
  distribution: Schema.Struct({
    npx: Schema.optional(AcpRegistryPackageDistribution),
    uvx: Schema.optional(AcpRegistryPackageDistribution),
    binary: Schema.optional(Schema.Record(Schema.String, AcpRegistryBinaryDistribution)),
  }),
});
export type AcpRegistryAgent = typeof AcpRegistryAgent.Type;

export const AcpRegistryIndex = Schema.Struct({
  version: TrimmedNonEmptyString,
  agents: Schema.Array(AcpRegistryAgent),
});
export type AcpRegistryIndex = typeof AcpRegistryIndex.Type;

export const AcpRegistryListResult = Schema.Struct({
  status: Schema.Literals(["ready", "unavailable"]),
  registryVersion: Schema.NullOr(TrimmedNonEmptyString),
  agents: Schema.Array(AcpRegistryAgent),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type AcpRegistryListResult = typeof AcpRegistryListResult.Type;

export const AcpRegistryListInput = Schema.Struct({
  registryUrl: Schema.optional(TrimmedNonEmptyString),
});
export type AcpRegistryListInput = typeof AcpRegistryListInput.Type;
