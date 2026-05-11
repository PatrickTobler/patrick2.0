import { getWhoopAccessToken } from "./auth.ts";

// v2 is the current WHOOP Developer API. Recovery and activity/sleep are v2-only
// (v1 404s); cycle and user/profile/basic are dual-versioned but we stay on v2
// for consistency.
const BASE = "https://api.prod.whoop.com/developer/v2";

async function call<T>(path: string): Promise<T> {
	const token = await getWhoopAccessToken();
	const res = await fetch(`${BASE}${path}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`WHOOP API ${res.status} on ${path}: ${body.slice(0, 300)}`);
	}
	return (await res.json()) as T;
}

// --- Raw API types (only the fields we use) ---

interface ScoreCycle {
	id: number;
	user_id: number;
	start: string; // ISO
	end: string | null;
	timezone_offset: string;
	score_state: "SCORED" | "PENDING_SCORE" | "UNSCORABLE";
	score?: {
		strain: number;
		kilojoule: number;
		average_heart_rate: number;
		max_heart_rate: number;
	};
}

interface Recovery {
	cycle_id: number;
	sleep_id: number;
	user_id: number;
	created_at: string;
	score_state: "SCORED" | "PENDING_SCORE" | "UNSCORABLE";
	score?: {
		user_calibrating: boolean;
		recovery_score: number;
		resting_heart_rate: number;
		hrv_rmssd_milli: number;
		spo2_percentage: number;
		skin_temp_celsius: number;
	};
}

interface SleepStageSummary {
	total_in_bed_time_milli: number;
	total_awake_time_milli: number;
	total_no_data_time_milli: number;
	total_light_sleep_time_milli: number;
	total_slow_wave_sleep_time_milli: number;
	total_rem_sleep_time_milli: number;
	sleep_cycle_count: number;
	disturbance_count: number;
}

interface Sleep {
	id: string;
	user_id: number;
	created_at: string;
	start: string;
	end: string;
	timezone_offset: string;
	nap: boolean;
	score_state: "SCORED" | "PENDING_SCORE" | "UNSCORABLE";
	score?: {
		stage_summary: SleepStageSummary;
		sleep_needed: {
			baseline_milli: number;
			need_from_sleep_debt_milli: number;
			need_from_recent_strain_milli: number;
			need_from_recent_nap_milli: number;
		};
		respiratory_rate: number;
		sleep_performance_percentage: number;
		sleep_consistency_percentage: number;
		sleep_efficiency_percentage: number;
	};
}

interface Workout {
	id: string;
	user_id: number;
	created_at: string;
	start: string;
	end: string;
	timezone_offset: string;
	sport_id: number;
	score_state: "SCORED" | "PENDING_SCORE" | "UNSCORABLE";
	score?: {
		strain: number;
		average_heart_rate: number;
		max_heart_rate: number;
		kilojoule: number;
		percent_recorded: number;
		distance_meter: number;
		altitude_gain_meter: number;
		altitude_change_meter: number;
		zone_duration: Record<string, number>;
	};
}

interface Paginated<T> {
	records: T[];
	next_token?: string;
}

// --- Listing helpers (single page; WHOOP returns ~10 per page) ---

export async function listRecoveries(opts: { start?: string; end?: string; limit?: number } = {}): Promise<Recovery[]> {
	const p = new URLSearchParams();
	if (opts.start) p.set("start", opts.start);
	if (opts.end) p.set("end", opts.end);
	if (opts.limit) p.set("limit", String(opts.limit));
	const data = await call<Paginated<Recovery>>(`/recovery?${p}`);
	return data.records;
}

export async function listSleep(opts: { start?: string; end?: string; limit?: number } = {}): Promise<Sleep[]> {
	const p = new URLSearchParams();
	if (opts.start) p.set("start", opts.start);
	if (opts.end) p.set("end", opts.end);
	if (opts.limit) p.set("limit", String(opts.limit));
	const data = await call<Paginated<Sleep>>(`/activity/sleep?${p}`);
	return data.records;
}

export async function listCycles(opts: { start?: string; end?: string; limit?: number } = {}): Promise<ScoreCycle[]> {
	const p = new URLSearchParams();
	if (opts.start) p.set("start", opts.start);
	if (opts.end) p.set("end", opts.end);
	if (opts.limit) p.set("limit", String(opts.limit));
	const data = await call<Paginated<ScoreCycle>>(`/cycle?${p}`);
	return data.records;
}

export async function listWorkouts(opts: { start?: string; end?: string; limit?: number } = {}): Promise<Workout[]> {
	const p = new URLSearchParams();
	if (opts.start) p.set("start", opts.start);
	if (opts.end) p.set("end", opts.end);
	if (opts.limit) p.set("limit", String(opts.limit));
	const data = await call<Paginated<Workout>>(`/activity/workout?${p}`);
	return data.records;
}

// --- Daily summary: assemble a clean structured view for one calendar day ---

export interface DailySummary {
	date: string; // YYYY-MM-DD as requested
	recovery: {
		score: number | null;
		hrv_ms: number | null;
		rhr_bpm: number | null;
		spo2_pct: number | null;
		skin_temp_c: number | null;
	};
	sleep: {
		score_pct: number | null;
		efficiency_pct: number | null;
		consistency_pct: number | null;
		performance_pct: number | null;
		respiratory_rate: number | null;
		stages_min: { rem: number | null; deep: number | null; light: number | null; awake: number | null };
		duration_min: number | null;
		needed_min: number | null;
		start: string | null;
		end: string | null;
	};
	cycle: {
		strain: number | null;
		avg_hr: number | null;
		max_hr: number | null;
		kilojoule: number | null;
		start: string | null;
		end: string | null;
	};
	workouts: Array<{ sport_id: number; strain: number | null; start: string; end: string; duration_min: number }>;
}

function msToMin(ms: number | undefined | null): number | null {
	if (ms === undefined || ms === null) return null;
	return Math.round(ms / 60_000);
}

// Build a daily summary by pulling everything that overlaps the local-time day
// for the user. WHOOP records are timezone-offset bearing; we filter on the
// `start` ISO field's date component.
export async function dailySummary(date: string): Promise<DailySummary> {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);
	const dayStart = `${date}T00:00:00.000Z`;
	const dayEnd = `${date}T23:59:59.999Z`;

	const [recoveries, sleeps, cycles, workouts] = await Promise.all([
		listRecoveries({ start: dayStart, end: dayEnd, limit: 5 }),
		listSleep({ start: dayStart, end: dayEnd, limit: 5 }),
		listCycles({ start: dayStart, end: dayEnd, limit: 5 }),
		listWorkouts({ start: dayStart, end: dayEnd, limit: 25 }),
	]);

	// Use the most recently scored record of each kind that overlaps the day.
	const r = recoveries.find((x) => x.score_state === "SCORED" && x.score);
	const s = sleeps.find((x) => !x.nap && x.score_state === "SCORED" && x.score);
	const c = cycles.find((x) => x.score_state === "SCORED" && x.score);

	const sleepDurationMs = s?.score?.stage_summary
		? s.score.stage_summary.total_in_bed_time_milli - s.score.stage_summary.total_awake_time_milli
		: null;
	const sleepNeededMs = s?.score?.sleep_needed
		? s.score.sleep_needed.baseline_milli +
			s.score.sleep_needed.need_from_sleep_debt_milli +
			s.score.sleep_needed.need_from_recent_strain_milli +
			s.score.sleep_needed.need_from_recent_nap_milli
		: null;

	return {
		date,
		recovery: {
			score: r?.score?.recovery_score ?? null,
			hrv_ms: r?.score?.hrv_rmssd_milli ?? null,
			rhr_bpm: r?.score?.resting_heart_rate ?? null,
			spo2_pct: r?.score?.spo2_percentage ?? null,
			skin_temp_c: r?.score?.skin_temp_celsius ?? null,
		},
		sleep: {
			score_pct: s?.score?.sleep_performance_percentage ?? null,
			efficiency_pct: s?.score?.sleep_efficiency_percentage ?? null,
			consistency_pct: s?.score?.sleep_consistency_percentage ?? null,
			performance_pct: s?.score?.sleep_performance_percentage ?? null,
			respiratory_rate: s?.score?.respiratory_rate ?? null,
			stages_min: {
				rem: msToMin(s?.score?.stage_summary.total_rem_sleep_time_milli),
				deep: msToMin(s?.score?.stage_summary.total_slow_wave_sleep_time_milli),
				light: msToMin(s?.score?.stage_summary.total_light_sleep_time_milli),
				awake: msToMin(s?.score?.stage_summary.total_awake_time_milli),
			},
			duration_min: msToMin(sleepDurationMs),
			needed_min: msToMin(sleepNeededMs),
			start: s?.start ?? null,
			end: s?.end ?? null,
		},
		cycle: {
			strain: c?.score?.strain ?? null,
			avg_hr: c?.score?.average_heart_rate ?? null,
			max_hr: c?.score?.max_heart_rate ?? null,
			kilojoule: c?.score?.kilojoule ?? null,
			start: c?.start ?? null,
			end: c?.end ?? null,
		},
		workouts: workouts
			.filter((w) => w.score_state === "SCORED")
			.map((w) => ({
				sport_id: w.sport_id,
				strain: w.score?.strain ?? null,
				start: w.start,
				end: w.end,
				duration_min: Math.round((new Date(w.end).getTime() - new Date(w.start).getTime()) / 60_000),
			})),
	};
}

export interface BasicProfile {
	user_id: number;
	email: string;
	first_name: string;
	last_name: string;
}

export async function basicProfile(): Promise<BasicProfile> {
	return call<BasicProfile>("/user/profile/basic");
}
