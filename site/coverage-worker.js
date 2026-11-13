import { RoadNetwork } from "./routing.js";

let network;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      const response = await fetch(data.url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Routing data: HTTP ${response.status}`);
      network = new RoadNetwork(await response.json());
      self.postMessage({ type: "ready" });
    } else if (data.type === "scenario" || data.type === "station") {
      if (!network) throw new Error("Routing data is not ready.");
      self.postMessage({
        type: "result", id: data.id,
        result: network.scenario(data.xy, { existingStation: data.type === "station" }),
      });
    }
  } catch (error) {
    console.error(error);
    self.postMessage({ type: "error", id: data.id, message: error.message });
  }
};
