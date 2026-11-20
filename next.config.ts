import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const config: NextConfig = {
  // pdfkit liest seine Schriftdateien (AFM) zur Laufzeit aus node_modules; gebündelt fände es sie nicht.
  serverExternalPackages: ["pdfkit"],
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
};

export default config;
