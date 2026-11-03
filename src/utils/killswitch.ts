import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";

/**
 * File-based kill switch (+ fail-closed latch if the pause write fails).
 * Presence of the kill file blocks NEW ENTRIES only; exits/TP-SL still allowed.
 * Disk is source of truth for the happy path: deleting the file resumes even
 * without /resume. If pause() cannot write the file, an in-memory latch keeps
 * entries blocked until /resume (otherwise /pause would be a silent no-op).
 */
export class KillSwitch {
  private readonly filePath: string;
  /** Set only when pause() failed to persist the kill file. */
  private writeFailedLatch = false;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  isPaused(): boolean {
    if (this.writeFailedLatch) return true;
    try {
      return fs.existsSync(this.filePath);
    } catch {
      // Cannot stat the file — if we believe a pause was requested, stay paused.
      return this.writeFailedLatch;
    }
  }

  pause(reason = "manual"): void {
    try {
      fs.writeFileSync(
        this.filePath,
        `paused_at=${new Date().toISOString()}\nreason=${reason}\n`,
        "utf8",
      );
      this.writeFailedLatch = false;
    } catch (e) {
      this.writeFailedLatch = true;
      log.warn("Failed to write kill switch file — in-memory latch keeps entries blocked", e);
    }
    log.warn(`Kill switch ON (${reason}) — new entries blocked; exits still allowed`);
  }

  resume(): void {
    this.writeFailedLatch = false;
    try {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    } catch (e) {
      log.warn("Failed to remove kill switch file", e);
    }
    log.info("Kill switch OFF — trading resumed");
  }
}
