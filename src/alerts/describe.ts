/**
 * An alert's condition in plain words: "price crosses 110 AND volume >= 1.5x
 * normal in last 30m", "trailing 3% off the low (started near 100)".
 *
 * Template-only, like src/narrative.ts. Recorded onto every revisit entry at
 * trigger time (`RevisitEntry.condition`), so a trigger's details say what
 * the alert was when it fired, even after the alert is edited or removed.
 */

import { formatVolume } from "../volume.js";
import { describeMaAlert } from "./maEngine.js";
import type { Alert, VolumeCondition } from "./models.js";

export function describeVolumeCondition(v: VolumeCondition): string {
  // An absolute threshold reads as "2.5M", not "2500000": these run to seven
  // digits and this sentence is read on a phone. Note that it is also the
  // `expect.condition` guard for a queued edit, so changing the wording
  // rejects everything queued before the deploy, once.
  const amount = v.threshold !== undefined ? `${formatVolume(v.threshold)} shares` : `${v.ratio}x normal`;
  return v.mode === "today" ? `volume >= ${amount} today` : `volume >= ${amount} in last ${v.periodValue}${v.periodUnit}`;
}

export function describeAlertCondition(alert: Alert): string {
  switch (alert.kind) {
    case "volume":
      return describeVolumeCondition(alert.volume);
    case "ma":
      return describeMaAlert(alert);
    case "static":
    case "trailing": {
      const price =
        alert.kind === "static"
          ? alert.direction === "either"
            ? `price crosses ${alert.level}`
            : `price crosses ${alert.direction === "down" ? "below" : "above"} ${alert.level}`
          : `trailing ${alert.trailType === "percent" ? `${alert.trailValue}%` : `$${alert.trailValue}`} ` +
            `off the ${alert.side === "below" ? "low" : "high"} (started near ${alert.near})`;
      return alert.volumeCondition ? `${price} AND ${describeVolumeCondition(alert.volumeCondition)}` : price;
    }
  }
}
