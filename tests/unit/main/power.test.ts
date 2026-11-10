import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { forwardPowerResume } from "../../../src/main/power";
import { createLogger } from "../../../src/shared/log";

describe("forwardPowerResume", () => {
  it("tells the core service each time the Mac wakes, until stopped", () => {
    const power = new EventEmitter();
    let told = 0;
    const stop = forwardPowerResume(
      power,
      () => {
        told += 1;
      },
      createLogger({ scope: "test", sink: () => undefined }),
    );
    power.emit("suspend");
    expect(told).toBe(0);
    power.emit("resume");
    power.emit("resume");
    expect(told).toBe(2);
    stop();
    power.emit("resume");
    expect(told).toBe(2);
  });
});
