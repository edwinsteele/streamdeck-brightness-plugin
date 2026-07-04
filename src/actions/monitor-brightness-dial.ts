import { action, DialAction, DialRotateEvent, SingletonAction, WillAppearEvent } from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import streamDeck from "@elgato/streamdeck";

const execFileAsync = promisify(execFile);

/** Brightness step per dial detent, in percent. */
const STEP = 10;

/** Lunar's own CLI, used only to read the current brightness for the touch-strip readout. */
const LUNAR_BIN = "/Users/esteele/.local/bin/lunar";

/** The user's existing script that performs the actual up/down adjustment. */
const SCRIPT_PATH = path.join(os.homedir(), "bin", "lunar-brightness.sh");

type DialSettings = {
	/** Fuzzy display name, matched the same way lunar-brightness.sh matches it. */
	displayName?: string;
};

type RotateState = {
	pendingTicks: number;
	busy: boolean;
};

/**
 * Encoder action bound to one Stream Deck+ dial. Each dial instance is configured (via the
 * property inspector) with the Lunar display name it should control. Rotating the dial adjusts
 * that monitor's brightness in 10% steps by shelling out to lunar-brightness.sh; the touch strip
 * above the dial shows the monitor name, current brightness, and a level bar.
 */
@action({ UUID: "com.esteele.monitorbrightness.dial" })
export class MonitorBrightnessDial extends SingletonAction<DialSettings> {
	private readonly rotateState = new Map<string, RotateState>();

	override async onWillAppear(ev: WillAppearEvent<DialSettings>): Promise<void> {
		const { action } = ev;
		if (!action.isDial()) return;

		const { displayName } = ev.payload.settings;
		if (!displayName) {
			await action.setFeedback({ title: "Set display", value: "--", indicator: { value: 0 } });
			return;
		}

		await this.refreshFeedback(action, displayName);
	}

	override onDialRotate(ev: DialRotateEvent<DialSettings>): void {
		const { action } = ev;
		if (!action.isDial()) return;

		const { displayName } = ev.payload.settings;
		if (!displayName) return;

		const state = this.getRotateState(action.id);
		state.pendingTicks += ev.payload.ticks;

		if (state.busy) return;
		void this.drainRotation(action, displayName, state);
	}

	/**
	 * Applies queued dial ticks one batch at a time. Rotating the dial fires many events in quick
	 * succession, and each adjustment involves two subprocess calls (adjust + re-read), so ticks
	 * that arrive while a batch is in flight are coalesced into the next one instead of racing.
	 */
	private async drainRotation(action: DialAction<DialSettings>, displayName: string, state: RotateState): Promise<void> {
		state.busy = true;
		try {
			while (state.pendingTicks !== 0) {
				const ticks = state.pendingTicks;
				state.pendingTicks = 0;

				const direction = ticks > 0 ? "up" : "down";
				const step = Math.abs(ticks) * STEP;

				try {
					await execFileAsync(SCRIPT_PATH, [displayName, direction, String(step)]);
				} catch (error) {
					streamDeck.logger.error(`lunar-brightness.sh failed for display "${displayName}"`, error);
				}

				await this.refreshFeedback(action, displayName);
			}
		} finally {
			state.busy = false;
		}
	}

	private async refreshFeedback(action: DialAction<DialSettings>, displayName: string): Promise<void> {
		const brightness = await this.queryBrightness(displayName);

		if (brightness === undefined) {
			await action.setFeedback({ title: displayName, value: "ERR", indicator: { value: 0 } });
			return;
		}

		await action.setFeedback({
			title: displayName,
			value: `${brightness}%`,
			indicator: { value: brightness }
		});
		await action.setSettings({ displayName });
	}

	private async queryBrightness(displayName: string): Promise<number | undefined> {
		try {
			const { stdout } = await execFileAsync(LUNAR_BIN, ["displays", displayName, "brightness"]);
			const match = stdout.match(/brightness:\s*(\d+)/i);
			return match ? Number(match[1]) : undefined;
		} catch (error) {
			streamDeck.logger.error(`Failed to read brightness for display "${displayName}"`, error);
			return undefined;
		}
	}

	private getRotateState(actionId: string): RotateState {
		let state = this.rotateState.get(actionId);
		if (!state) {
			state = { pendingTicks: 0, busy: false };
			this.rotateState.set(actionId, state);
		}
		return state;
	}
}
