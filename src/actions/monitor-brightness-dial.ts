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

type WriteState = {
	pendingTarget: number | undefined;
	writing: boolean;
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
 *
 * The touch strip and the in-memory brightness cache update the instant a target is computed;
 * the actual `lunar` write happens in the background (see queueWrite), so a fast multi-step twist
 * feels immediate instead of waiting on a subprocess round-trip per detent.
 */
@action({ UUID: "com.esteele.monitorbrightness.dial" })
export class MonitorBrightnessDial extends SingletonAction<DialSettings> {
	private readonly rotateState = new Map<string, RotateState>();

	/** Last known (rounded) brightness per display, so rotation doesn't need a read before every write. */
	private readonly brightnessCache = new Map<string, number>();

	/** Per-display hardware write queue, so writes apply in order without blocking the UI on them. */
	private readonly writeState = new Map<string, WriteState>();

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

		const brightness = await this.syncBrightness(displayName);
		await this.applyFeedback(action, displayName, brightness);
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
			let target: number;

			if (previousBrightness === undefined) {
				const current = await this.getCurrentBrightness(displayName);
				if (current === undefined) {
					await action.setFeedback({ title: displayName, value: "ERR", indicator: { value: 0 } });
					return;
				}

				target = 0;
				await action.setSettings({ displayName, previousBrightness: current });
			} else {
				target = previousBrightness;
				await action.setSettings({ displayName });
			}

			this.brightnessCache.set(displayName, target);
			await this.applyFeedback(action, displayName, target);
			this.queueWrite(displayName, target);
		} finally {
			state.busy = false;
		}
	}

	/**
	 * Applies queued dial ticks one batch at a time. Rotating the dial fires many events in quick
	 * succession, so ticks that arrive while a batch is in flight are coalesced into the next one
	 * instead of racing. Each batch computes its target from the in-memory cache (not a fresh
	 * read) and updates the touch strip immediately; the hardware write is queued separately.
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

				const current = await this.getCurrentBrightness(displayName);
				if (current === undefined) continue;

				const target = Math.max(0, Math.min(100, current + ticks * STEP));
				this.brightnessCache.set(displayName, target);
				await this.applyFeedback(action, displayName, target);
				this.queueWrite(displayName, target);
			}
		} finally {
			state.busy = false;
		}
	}

	private async refreshAfterWake(action: DialAction<DialSettings>, displayName: string): Promise<void> {
		let raw = await this.queryBrightness(displayName);
		if (raw === undefined) {
			// DDC often isn't ready the instant displays wake; give it one retry.
			await delay(WAKE_RETRY_DELAY_MS);
			raw = await this.queryBrightness(displayName);
		}

		const brightness = raw === undefined ? undefined : round10(raw);
		if (brightness === undefined) {
			this.brightnessCache.delete(displayName);
		} else {
			this.brightnessCache.set(displayName, brightness);
		}

		await this.applyFeedback(action, displayName, brightness);
	}

	private async applyFeedback(action: DialAction<DialSettings>, displayName: string, brightness: number | undefined): Promise<void> {
		if (brightness === undefined) {
			await action.setFeedback({ title: displayName, value: "ERR", indicator: { value: 0 } });
			return;
		}

		await action.setFeedback({
			title: displayName,
			value: `${brightness}%`,
			indicator: { value: brightness }
		});
	}

	/** Returns the cached brightness if known, otherwise falls back to a live read (and caches it). */
	private async getCurrentBrightness(displayName: string): Promise<number | undefined> {
		const cached = this.brightnessCache.get(displayName);
		if (cached !== undefined) return cached;
		return this.syncBrightness(displayName);
	}

	/** Always does a live read from Lunar, rounds it, and updates the cache with the result. */
	private async syncBrightness(displayName: string): Promise<number | undefined> {
		const raw = await this.queryBrightness(displayName);
		if (raw === undefined) return undefined;

		const brightness = round10(raw);
		this.brightnessCache.set(displayName, brightness);
		return brightness;
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

	/**
	 * Queues a hardware write for a display without blocking the caller. If further writes come in
	 * before this one starts, only the latest target survives — a fast twist through several
	 * intermediate values ends up sending just the final one instead of replaying every step.
	 */
	private queueWrite(displayName: string, target: number): void {
		const state = this.getWriteState(displayName);
		state.pendingTarget = target;

		if (state.writing) return;
		void this.drainWrites(displayName, state);
	}

	private async drainWrites(displayName: string, state: WriteState): Promise<void> {
		state.writing = true;
		try {
			while (state.pendingTarget !== undefined) {
				const target = state.pendingTarget;
				state.pendingTarget = undefined;
				await this.setBrightness(displayName, target);
			}
		} finally {
			state.writing = false;
		}
	}

	private getWriteState(displayName: string): WriteState {
		let state = this.writeState.get(displayName);
		if (!state) {
			state = { pendingTarget: undefined, writing: false };
			this.writeState.set(displayName, state);
		}
		return state;
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
