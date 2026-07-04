import { action, DialAction, DialDownEvent, DialRotateEvent, SingletonAction, WillAppearEvent } from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import streamDeck from "@elgato/streamdeck";

const execFileAsync = promisify(execFile);

/** Brightness step per dial detent, in percent. Values are always rounded to a multiple of this. */
const STEP = 10;

/** Lunar's own CLI: used both to read brightness and to apply exact (rounded) values. */
const LUNAR_BIN = "/Users/esteele/.local/bin/lunar";

/** How long to wait before retrying a brightness read that failed right after waking from sleep. */
const WAKE_RETRY_DELAY_MS = 3000;

type DialSettings = {
	/** Fuzzy display name, matched the same way lunar-brightness.sh matches it. */
	displayName?: string;
	/** Brightness to restore to on the next press, set only while the display is blacked out. */
	previousBrightness?: number;
};

type RotateState = {
	pendingTicks: number;
	busy: boolean;
};

function round10(value: number): number {
	return Math.round(value / STEP) * STEP;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Encoder action bound to one Stream Deck+ dial. Each dial instance is configured (via the
 * property inspector) with the Lunar display name it should control.
 *
 * - Rotating the dial adjusts that monitor's brightness in 10% steps.
 * - Pressing the dial blacks the monitor out (0%); pressing again restores the brightness it had
 *   beforehand.
 * - The touch strip above the dial shows the monitor name, current brightness (rounded to the
 *   nearest 10%), and a level bar.
 */
@action({ UUID: "com.esteele.monitorbrightness.dial" })
export class MonitorBrightnessDial extends SingletonAction<DialSettings> {
	private readonly rotateState = new Map<string, RotateState>();

	constructor() {
		super();

		// The Stream Deck app doesn't re-fire onWillAppear when the Mac wakes from sleep, so a
		// dial's touch-strip readout would otherwise keep showing whatever it last displayed
		// before sleeping. Refresh every visible instance from Lunar once the system wakes.
		streamDeck.system.onSystemDidWakeUp(() => {
			for (const instance of this.actions) {
				if (!instance.isDial()) continue;

				void instance.getSettings().then(({ displayName }) => {
					if (displayName) void this.refreshAfterWake(instance, displayName);
				});
			}
		});
	}

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

	override async onDialDown(ev: DialDownEvent<DialSettings>): Promise<void> {
		const { action } = ev;
		if (!action.isDial()) return;

		const { displayName, previousBrightness } = ev.payload.settings;
		if (!displayName) return;

		// Avoid racing a press against an in-flight rotation on the same dial.
		const state = this.getRotateState(action.id);
		if (state.busy) return;
		state.busy = true;

		try {
			if (previousBrightness === undefined) {
				const raw = await this.queryBrightness(displayName);
				if (raw === undefined) return;

				await this.setBrightness(displayName, 0);
				await action.setSettings({ displayName, previousBrightness: round10(raw) });
			} else {
				await this.setBrightness(displayName, previousBrightness);
				await action.setSettings({ displayName });
			}

			await this.refreshFeedback(action, displayName);
		} finally {
			state.busy = false;
		}
	}

	/**
	 * Applies queued dial ticks one batch at a time. Rotating the dial fires many events in quick
	 * succession, so ticks that arrive while a batch is in flight are coalesced into the next one
	 * instead of racing.
	 */
	private async drainRotation(action: DialAction<DialSettings>, displayName: string, state: RotateState): Promise<void> {
		state.busy = true;
		try {
			// A manual rotation means the user is taking direct control, so drop any pending
			// blackout restore point rather than let a later press jump back to a stale value.
			await action.setSettings({ displayName });

			while (state.pendingTicks !== 0) {
				const ticks = state.pendingTicks;
				state.pendingTicks = 0;

				const raw = await this.queryBrightness(displayName);
				if (raw === undefined) continue;

				const target = Math.max(0, Math.min(100, round10(raw) + ticks * STEP));
				await this.setBrightness(displayName, target);
				await this.applyFeedback(action, displayName, target);
			}
		} finally {
			state.busy = false;
		}
	}

	private async refreshFeedback(action: DialAction<DialSettings>, displayName: string): Promise<void> {
		const raw = await this.queryBrightness(displayName);
		await this.applyFeedback(action, displayName, raw);
	}

	private async refreshAfterWake(action: DialAction<DialSettings>, displayName: string): Promise<void> {
		let raw = await this.queryBrightness(displayName);
		if (raw === undefined) {
			// DDC often isn't ready the instant displays wake; give it one retry.
			await delay(WAKE_RETRY_DELAY_MS);
			raw = await this.queryBrightness(displayName);
		}
		await this.applyFeedback(action, displayName, raw);
	}

	private async applyFeedback(action: DialAction<DialSettings>, displayName: string, raw: number | undefined): Promise<void> {
		if (raw === undefined) {
			await action.setFeedback({ title: displayName, value: "ERR", indicator: { value: 0 } });
			return;
		}

		const brightness = round10(raw);
		await action.setFeedback({
			title: displayName,
			value: `${brightness}%`,
			indicator: { value: brightness }
		});
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

	private async setBrightness(displayName: string, value: number): Promise<void> {
		try {
			await execFileAsync(LUNAR_BIN, ["displays", displayName, "brightness", String(value)]);
		} catch (error) {
			streamDeck.logger.error(`Failed to set brightness for display "${displayName}"`, error);
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
