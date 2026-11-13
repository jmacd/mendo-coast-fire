import { defineConfig } from "vite";
import { existsSync } from "node:fs";

export default defineConfig({
  root: "site",
  base: "./",
  publicDir: "../output",
  build: { outDir: "../_site", emptyOutDir: true },
  plugins: [{
    name: "require-coverage-data",
    apply: "build",
    buildStart() {
      for (const name of ["graph.json", "summary.json", "parcels.geojson", "stations.geojson", "highway.geojson", "provenance.json", "stations.csv"]) {
        if (!existsSync(`output/${name}`)) throw new Error(`Missing output/${name}. Run fire-coverage run before building.`);
      }
    },
  }],
  server: { open: false },
  preview: { open: false, port: 4180, strictPort: true },
});
