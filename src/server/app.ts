import { ZodError } from "zod";
import { HttpError, httpErrorResponse, notFound, reportError, validationError } from "@intgetion/kit";
import * as ingestion from "../modules/ingestion/service";
import { ingestionPorts } from "../ports";
import { isUuid, optionalCaller, requireServiceToken } from "./auth";

export type AppConfig = {
  serviceToken: string;
  /** Live sources on; off runs the fixture import (local databases only). */
  liveImport: boolean;
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

type Route = {
  method: string;
  pattern: RegExp;
  run: (request: Request, params: string[], config: AppConfig) => Promise<Response>;
};

const routes: Route[] = [
  {
    // Cron: one import pass (live sources, or the fixtures on a local database).
    method: "POST",
    pattern: /^\/v1\/tasks\/import$/,
    run: async (_request, _p, config) => {
      const sources = config.liveImport ? await ingestion.runLiveImports() : await ingestion.runFixtureImports();
      return json({ ok: true, live: config.liveImport, sources });
    },
  },
  {
    // The external link of a published imported job; a signed-in click is recorded.
    method: "POST",
    pattern: /^\/v1\/jobs\/([^/]+)\/apply-external$/,
    run: async (request, [jobId]) => {
      if (!jobId || !isUuid(jobId)) throw notFound();
      const userId = optionalCaller(request)?.userId ?? null;
      return json(await ingestion.applyExternal(jobId, userId, ingestionPorts().recordAppliedExternal));
    },
  },
  // Admin (the platform checks `import.manage`).
  {
    method: "GET",
    pattern: /^\/v1\/admin\/runs$/,
    run: async () => json({ runs: await ingestion.listImportRuns(50) }),
  },
  {
    method: "GET",
    pattern: /^\/v1\/admin\/sources$/,
    run: async () => json({ sources: await ingestion.listImportSources() }),
  },
];

export function toResponse(error: unknown): Response {
  if (error instanceof HttpError) return httpErrorResponse(error);
  if (error instanceof ZodError) return httpErrorResponse(validationError(error.issues));
  reportError(error, "ingestion-service");
  return Response.json({ error: { code: "INTERNAL", message: "Internal error" } }, { status: 500 });
}

export function createApp(config: AppConfig) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
      requireServiceToken(request, config.serviceToken);
      for (const route of routes) {
        if (route.method !== request.method) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        return await route.run(request, match.slice(1), config);
      }
      throw notFound();
    } catch (error) {
      return toResponse(error);
    }
  };
}
