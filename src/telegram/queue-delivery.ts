import { dueQueuedNotifications, markNotificationsDelivered } from "../db/repos/notifications.ts";
import { log } from "../log.ts";
import { sendTelegramToOwner } from "./sender.ts";

const POLL_INTERVAL_MS = 5 * 60_000;

let timer: NodeJS.Timeout | null = null;

async function deliverDue(): Promise<void> {
	try {
		const due = await dueQueuedNotifications();
		if (due.length === 0) return;
		const body =
			due.length === 1
				? (due[0]?.text ?? "")
				: `While you were offline (${due.length} held back):\n\n${due.map((n) => `• ${n.text}`).join("\n\n")}`;
		await sendTelegramToOwner(body);
		await markNotificationsDelivered(due.map((n) => n.id));
		log.info({ count: due.length }, "delivered queued notifications");
	} catch (err) {
		log.warn({ err }, "queued notification delivery failed");
	}
}

export function startQueuedNotificationDelivery(): void {
	if (timer) return;
	timer = setInterval(() => void deliverDue(), POLL_INTERVAL_MS);
	void deliverDue(); // catch anything due from before a restart
}

export function stopQueuedNotificationDelivery(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}
