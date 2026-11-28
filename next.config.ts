import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const config: NextConfig = {
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  // pdfkit reads its font metrics (data/*.afm) relative to its own files: keep it in node_modules, not in the bundle.
  serverExternalPackages: ["pdfkit"],
  // Upload der Interessenabwägung (höchstens 2 MB, geprüft in der Server Action) plus Formular-Overhead.
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
};

export default config;
