// After the pointer lifts, how long to wait for that press's click before
// treating the press as over (the pointer slid off the button, or the click
// was cancelled). Browsers send the click right after the pointer lifts.
export const POINTER_CLICK_SUPPRESSION_MS = 400;

/** The window the buttons live in: timers plus window-level event listeners. */
export interface ActivationWindow {
	setTimeout(handler: () => void, timeout: number): number;
	clearTimeout(handle: number): void;
	addEventListener(type: string, listener: (event: Event) => void, options?: boolean | AddEventListenerOptions): void;
	removeEventListener(type: string, listener: (event: Event) => void, options?: boolean | EventListenerOptions): void;
}

/**
 * Whether a click came from a pointer press rather than the keyboard or
 * assistive technology. Chromium (Obsidian desktop and Android) reports clicks
 * as PointerEvents whose `pointerType` is "mouse", "touch" or "pen", and ""
 * for keyboard activation; its touch-tap clicks have `detail === 0`, so
 * `detail` alone cannot tell them apart. WebKit reports taps with
 * `detail >= 1` and keyboard clicks with `detail === 0`.
 */
function isPointerGeneratedClick(event: Event): boolean {
	const pointerType = (event as Partial<PointerEvent>).pointerType;
	if (typeof pointerType === "string" && pointerType !== "") {
		return true;
	}
	return ((event as Partial<MouseEvent>).detail ?? 0) > 0;
}

/**
 * State of one press for an action, shared by every button that performs the
 * action. Activating Undo or Redo rebuilds the toolbar, so the press's click
 * can land on a freshly created button (a finger or stylus tap) or on the
 * toolbar around it (a mouse or pen press whose button was removed). State kept
 * on the old button was lost with it, and a tap ran the action twice.
 */
export interface ButtonActivationGuard {
	/** A press started on a button and has not finished yet. */
	pressActive: boolean;
	/** Pointer that started the press. */
	pointerId: number | null;
	/** Set while the press's own click is being dispatched, so buttons ignore it. */
	swallowClick: boolean;
	timer: number | null;
	release: (() => void) | null;
}

export function createButtonActivationGuard(): ButtonActivationGuard {
	return { pressActive: false, pointerId: null, swallowClick: false, timer: null, release: null };
}

/**
 * Runs `onActivate` exactly once per press.
 *
 * Pointer input activates on `pointerdown` so pen and touch taps respond
 * immediately. The press then ends with its click, wherever that click lands
 * (the same button, a rebuilt one, or the toolbar), and buttons sharing the
 * guard ignore that click. A second contact during a press (a palm or another
 * finger) is part of the same tap. Clicks without a preceding press (keyboard
 * Enter/Space, assistive technology) activate normally.
 */
export function bindSingleButtonActivation(
	button: HTMLButtonElement,
	win: ActivationWindow,
	onActivate: () => void,
	guard: ButtonActivationGuard = createButtonActivationGuard()
): void {
	const endPress = (): void => {
		guard.release?.();
		guard.release = null;
		guard.pressActive = false;
		guard.pointerId = null;
		if (guard.timer !== null) {
			win.clearTimeout(guard.timer);
			guard.timer = null;
		}
	};

	const trackPress = (pointerId: number | null): void => {
		const onPointerEnd = (event: Event): void => {
			if (guard.pointerId !== null && (event as Partial<PointerEvent>).pointerId !== guard.pointerId) {
				return;
			}
			// Wait briefly for this press's click; if none comes, the press is over.
			if (guard.timer !== null) {
				win.clearTimeout(guard.timer);
			}
			guard.timer = win.setTimeout(endPress, POINTER_CLICK_SUPPRESSION_MS);
		};
		const onClick = (event: Event): void => {
			if (!isPointerGeneratedClick(event)) {
				return;
			}
			// This is the press's own click: let it pass through without activating anything.
			guard.swallowClick = true;
			win.setTimeout(() => {
				guard.swallowClick = false;
			}, 0);
			endPress();
		};
		guard.pointerId = pointerId;
		win.addEventListener("pointerup", onPointerEnd, true);
		win.addEventListener("pointercancel", onPointerEnd, true);
		win.addEventListener("click", onClick, true);
		guard.release = () => {
			win.removeEventListener("pointerup", onPointerEnd, true);
			win.removeEventListener("pointercancel", onPointerEnd, true);
			win.removeEventListener("click", onClick, true);
		};
	};

	button.addEventListener("pointerdown", (event) => {
		event.stopPropagation();
		if (button.disabled) {
			return;
		}
		if (event.pointerType === "mouse" && event.button !== 0) {
			return;
		}
		event.preventDefault();
		if (guard.pressActive) {
			if (guard.pointerId === event.pointerId) {
				// The same pointer pressing again means the previous press ended unseen.
				endPress();
			} else {
				// Another contact during this press belongs to the same tap.
				return;
			}
		}
		guard.pressActive = true;
		trackPress(typeof event.pointerId === "number" ? event.pointerId : null);
		onActivate();
	});

	button.addEventListener("click", (event) => {
		event.stopPropagation();
		event.preventDefault();
		if (guard.swallowClick && isPointerGeneratedClick(event)) {
			return;
		}
		if (!button.disabled) {
			onActivate();
		}
	});
}
