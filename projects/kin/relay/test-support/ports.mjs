// Holds a port number for TCP only, for the tests of a DNS port that TCP
// already has (#469). A number from a TCP listen(0) may be held for UDP by
// another process, so the number comes from UDP first: the TCP holder takes
// it, and the UDP probe closes last, leaving that number free for UDP.
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { createServer } from "node:net";

export async function holdTcpOnly(host = "127.0.0.1") {
  for (let attempt = 1; ; attempt += 1) {
    const probe = createSocket("udp4");
    await new Promise((resolve, reject) => { probe.once("error", reject); probe.bind(0, host, resolve); });
    const taken = probe.address().port;
    const holder = createServer().listen(taken, host);
    try { await once(holder, "listening"); } catch (error) {
      await new Promise((resolve) => probe.close(resolve));
      if (!["EADDRINUSE", "EACCES"].includes(error.code) || attempt === 20) throw error;
      continue;
    }
    await new Promise((resolve) => probe.close(resolve));
    return { taken, release: () => new Promise((resolve) => holder.close(resolve)) };
  }
}
