import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = process.env.ALTER_HARNESS === "mine" ? "data" : "sample";
const read = (name) => fs.readFileSync(path.join(here, source, name), "utf8");

export default defineConfig({
  root: path.resolve(here, "../.."),
  plugins: [
    react(),
    {
      name: "alter-ui-harness",
      configureServer(server) {
        server.middlewares.use("/@harness/boot.js", (_req, res) => {
          res.setHeader("Content-Type", "text/javascript");
          res.end(
            `window.__HARNESS_CHATS__=${read("chats.json")};window.__HARNESS_LS__=${read("storage.json")};\n` +
              fs.readFileSync(path.join(here, "mock.js"), "utf8"),
          );
        });
      },
      transformIndexHtml(html) {
        return html.replace("<head>", '<head><script src="/@harness/boot.js"></script>');
      },
    },
  ],
  server: { port: 5174, strictPort: true },
});
