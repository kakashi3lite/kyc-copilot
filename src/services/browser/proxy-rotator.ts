import { env } from "../../config/env.js";

export class ProxyRotator {
  private cursor = 0;
  private readonly proxies: string[];
  public constructor(raw = env.PROXY_LIST) { this.proxies = raw.split(",").map((entry) => entry.trim()).filter(Boolean); }
  public next(_jurisdiction: string): string | null {
    if (this.proxies.length === 0) return null;
    const value = this.proxies[this.cursor % this.proxies.length] ?? null;
    this.cursor += 1;
    return value;
  }
}
