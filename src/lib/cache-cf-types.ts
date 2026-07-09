/** Minimal shapes for the Cloudflare V4 REST and GraphQL responses we touch. */

export type CfError = {
  code?: number;
  message?: string;
};

/** Standard V4 REST envelope. */
export type CfEnvelope<T = unknown> = {
  success?: boolean;
  errors?: CfError[];
  result?: T;
};

export type CfZone = {
  id?: string;
  name?: string;
  status?: string;
  development_mode?: number;
};

export type CfRawRule = {
  id?: string;
  description?: string;
  expression?: string;
  enabled?: boolean;
  action?: string;
  action_parameters?: unknown;
};

export type CfRuleset = {
  rules?: CfRawRule[];
};

export type GqlGroup = {
  count?: number;
  avg?: { sampleInterval?: number };
  dimensions?: Record<string, string | undefined>;
};

/** Version Management (kamino) environment — GET /zones/{id}/environments. */
export type CfEnvironment = {
  name?: string;
  ref?: string;
  version?: number | null;
  expression?: string;
};

export type CfEnvironmentsResult = {
  environments?: CfEnvironment[];
};

export type GqlError = {
  message?: string;
  extensions?: { code?: string };
};

export type GqlResponse = {
  data?: {
    viewer?: {
      zones?: Array<Record<string, GqlGroup[] | undefined>>;
    };
  };
  errors?: GqlError[] | null;
};

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
