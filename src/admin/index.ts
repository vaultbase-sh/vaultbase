import Elysia from "elysia";
import { join } from "path";

export function makeAdminPlugin() {
  const distDir = join(import.meta.dir, "../../admin/dist");

  return new Elysia({ name: "admin-ui" }).get("/_/*", async ({ request, set }) => {
    const url = new URL(request.url);
    let pathname = url.pathname.replace(/^\/_/, "");
    if (pathname === "" || pathname === "/") pathname = "/index.html";

    const filePath = join(distDir, pathname);
    const file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file);
    }

    const index = Bun.file(join(distDir, "index.html"));
    if (await index.exists()) {
      return new Response(index, { headers: { "Content-Type": "text/html" } });
    }

    set.status = 404;
    return "Admin UI not built. Run: bun run build:admin";
  });
}
