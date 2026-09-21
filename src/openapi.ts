/**
 * The OpenAPI document served at `GET /openapi.json`.
 *
 * It lives in code rather than a static file so `servers[0].url` always
 * matches the deployment answering the request — which means "Try it" in
 * Swagger UI, Scalar or Postman works without anyone editing a YAML file.
 */
export function openApiSpec(origin: string): Record<string, unknown> {
  const fileSchema = {
    type: "object",
    properties: {
      fs_id: { type: "string", description: "TeraBox file id; selects this file from the share." },
      file_name: { type: "string" },
      path: { type: "string", description: "Path inside the share." },
      file_size: { type: "string", examples: ["1.5 GB"] },
      size_bytes: { type: "integer" },
      category: {
        type: "string",
        enum: ["video", "audio", "image", "document", "application", "other"],
      },
      mime_type: { type: "string", examples: ["video/mp4"] },
      md5: { type: "string" },
      thumbnail: { type: "string" },
      modified_at: { type: ["integer", "null"], description: "Unix seconds." },
      stream_url: { type: "string", description: "Proxied bytes, Range-capable." },
      download_url: { type: "string", description: "Same, forced as an attachment." },
      hls_url: {
        type: ["string", "null"],
        description: "Rewritten HLS manifest. Non-null only for video files.",
      },
    },
  };

  const errorSchema = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["error"] },
      error: {
        type: "object",
        properties: {
          code: {
            type: "string",
            enum: [
              "missing_parameter",
              "invalid_parameter",
              "unsupported_host",
              "unauthorized",
              "password_required",
              "empty_share",
              "not_found",
              "rate_limited",
              "verification_required",
              "cookie_invalid",
              "budget_exhausted",
              "upstream_unexpected",
              "upstream_unavailable",
              "internal",
            ],
          },
          message: { type: "string" },
        },
      },
      request_id: { type: "string" },
    },
  };

  const shareSchema = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["success"] },
      cached: { type: "boolean" },
      url: { type: "string" },
      share: {
        type: "object",
        properties: {
          id: { type: "string", description: "Short share id (surl)." },
          share_id: { type: "string", description: "Numeric share id." },
          uk: { type: "string", description: "Owner user key." },
          resolved_url: { type: "string" },
          password_protected: { type: "boolean" },
          file_count: { type: "integer" },
          truncated: {
            type: "boolean",
            description: "True when the 200-file cap left entries out.",
          },
          strategy: { type: "string", enum: ["signed", "anonymous", "wap"] },
        },
      },
      files: { type: "array", items: fileSchema },
      file_name: { type: "string", description: "Alias for files[0]." },
      stream_url: { type: "string", description: "Alias for files[0]." },
    },
  };

  const linkParam = {
    name: "link",
    in: "query",
    required: true,
    schema: { type: "string" },
    description: "A public TeraBox share URL.",
  };
  const fsIdParam = {
    name: "fs_id",
    in: "query",
    schema: { type: "string" },
    description: "Select one file from a multi-file share.",
  };
  const passwordParam = {
    name: "password",
    in: "query",
    schema: { type: "string" },
    description: "Required for password-protected shares.",
  };

  const errorResponses = {
    "400": {
      description: "Bad parameters.",
      content: { "application/json": { schema: errorSchema } },
    },
    "401": {
      description: "API key missing, or the share needs a password.",
      content: { "application/json": { schema: errorSchema } },
    },
    "404": { description: "Share or file not found." },
    "429": { description: "Rate limit exceeded." },
    "502": { description: "TeraBox was unreachable or answered unexpectedly." },
    "503": { description: "CAPTCHA wall or request budget exhausted. Retryable." },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "TeraBox API",
      version: "2.0.3",
      description:
        "Resolves public TeraBox share links into file metadata, direct downloads and HLS streams. Self-hosted on Cloudflare Workers.",
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Only required when the worker is deployed with an API_KEY secret.",
        },
      },
      schemas: { File: fileSchema, Share: shareSchema, Error: errorSchema },
    },
    paths: {
      "/api/resolve": {
        get: {
          summary: "Resolve a share link",
          operationId: "resolveShare",
          parameters: [linkParam, passwordParam, fsIdParam],
          responses: {
            "200": {
              description: "The share was resolved.",
              content: { "application/json": { schema: shareSchema } },
            },
            ...errorResponses,
          },
        },
        post: {
          summary: "Resolve a share link (JSON body)",
          operationId: "resolveShareJson",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["link"],
                  properties: {
                    link: { type: "string" },
                    password: { type: "string" },
                    fs_id: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "The share was resolved.",
              content: { "application/json": { schema: shareSchema } },
            },
            ...errorResponses,
          },
        },
      },
      "/api/batch": {
        post: {
          summary: "Resolve up to 8 share links at once",
          operationId: "resolveBatch",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["links"],
                  properties: {
                    links: { type: "array", items: { type: "string" }, maxItems: 8 },
                    password: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Per-link results. Individual failures are reported inline, not as an HTTP error.",
            },
            ...errorResponses,
          },
        },
      },
      "/stream": {
        get: {
          summary: "Stream or download the file",
          operationId: "streamFile",
          parameters: [
            linkParam,
            fsIdParam,
            passwordParam,
            {
              name: "download",
              in: "query",
              schema: { type: "string", enum: ["1"] },
              description: "Force an attachment instead of inline playback.",
            },
            {
              name: "Range",
              in: "header",
              schema: { type: "string" },
              description: "Standard byte-range header; enables seeking and resuming.",
            },
          ],
          responses: {
            "200": { description: "Full file body." },
            "206": { description: "Partial content, in response to a Range request." },
            ...errorResponses,
          },
        },
        head: {
          summary: "File headers only",
          operationId: "headFile",
          parameters: [linkParam, fsIdParam],
          responses: { "200": { description: "Headers only, no body." } },
        },
      },
      "/hls": {
        get: {
          summary: "HLS manifest for a video file",
          operationId: "hlsManifest",
          parameters: [
            linkParam,
            fsIdParam,
            passwordParam,
            {
              name: "quality",
              in: "query",
              schema: { type: "string", enum: ["480", "720", "1080"], default: "720" },
            },
          ],
          responses: {
            "200": {
              description: "An M3U8 playlist whose segments point back at /segment.",
              content: { "application/vnd.apple.mpegurl": { schema: { type: "string" } } },
            },
            ...errorResponses,
          },
        },
      },
      "/segment": {
        get: {
          summary: "Proxy one HLS segment",
          description: "Only accepts tokens minted by /hls. Not intended to be called directly.",
          operationId: "hlsSegment",
          parameters: [{ name: "t", in: "query", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Segment bytes." },
            "403": { description: "Invalid or expired token." },
          },
        },
      },
      "/health": {
        get: {
          summary: "Liveness and configuration summary",
          operationId: "health",
          security: [],
          responses: { "200": { description: "The worker is up." } },
        },
      },
    },
  };
}
