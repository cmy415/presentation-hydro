import path from "path";
import {
    _, ContestModel, Context, db, fs, Handler,
    ObjectId, param, PERM, ProblemModel, STATUS,
    STATUS_TEXTS, Types, UserModel, SystemModel,
} from "hydrooj";

const coll = db.collection("record");
const PENDING_STATUSES = [STATUS.STATUS_WAITING, STATUS.STATUS_FETCHED, STATUS.STATUS_COMPILING, STATUS.STATUS_JUDGING];
const FAIL_STATUSES = [STATUS.STATUS_WRONG_ANSWER, STATUS.STATUS_TIME_LIMIT_EXCEEDED,
    STATUS.STATUS_MEMORY_LIMIT_EXCEEDED, STATUS.STATUS_RUNTIME_ERROR, STATUS.STATUS_COMPILE_ERROR];

function getContestPhase(tdoc: any) {
    const now = Date.now(), beginAt = tdoc.beginAt.getTime(), endAt = tdoc.endAt.getTime();
    const lockAt = tdoc.lockAt ? tdoc.lockAt.getTime() : null;
    if (now < beginAt) return { phase: "pending", targetTime: beginAt };
    if (now < endAt) { if (lockAt && now >= lockAt) return { phase: "frozen", targetTime: endAt }; return { phase: "running", targetTime: endAt }; }
    return { phase: "ended", targetTime: null };
}

export function apply(ctx: Context) {
    const tpl = fs.readFileSync(path.join(__dirname, "templates", "presentation.html"), "utf8");

    class PresentationPageHandler extends Handler {
        noCheckPermView = true;
        @param("tid", Types.ObjectId)
        async get(domainId: string, tid: ObjectId) {
            const tdoc = await ContestModel.get(domainId, tid);
            if (!tdoc) { this.response.status = 404; this.response.body = "Contest not found"; return; }
            if (!ContestModel.isOngoing(tdoc) && !ContestModel.isDone(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            const basePath = "/d/" + domainId + "/contest/" + tid + "/presentation";
            this.response.body = tpl.replace(/__BASE_PATH__/g, basePath).replace(/__CONTEST_ID__/g, tid.toString()).replace(/__DOMAIN_ID__/g, domainId).replace(/__CONTEST_TITLE__/g, tdoc.title || "Contest");
            this.response.type = "text/html";
        }
    }

    class PresentationStateHandler extends Handler {
        noCheckPermView = true;
        @param("tid", Types.ObjectId)
        async get(domainId: string, tid: ObjectId) {
            const tdoc = await ContestModel.get(domainId, tid);
            if (!tdoc) { this.response.body = {}; return; }

            const { phase, targetTime } = getContestPhase(tdoc);

            // Use Hydro's native scoreboard (correct ICPC penalty calculation)
            const config: any = { isExport: false, showDisplayName: false, lockAt: ContestModel.isLocked(tdoc) };
            let rows: any[] = [], udict: Record<number, any> = {};
            try {
                const result = await ContestModel.getScoreboard.call(this, domainId, tid, config);
                rows = result[1]; udict = result[2];
            } catch (e) {
                // Fallback: get raw data if scoreboard not available
                const tsdocs = await ContestModel.getMultiStatus(domainId, { docId: tdoc._id }).toArray();
                const uids = [...new Set(tsdocs.map((ts: any) => ts.uid))];
                udict = await UserModel.getList(domainId, uids);
            }

            // Filter: first row is header, skip unranked
            const ranked = rows.slice(1).filter((r: any) => {
                const raw = r.find((c: any) => c.type === "user")?.raw;
                return raw != null;
            });

            // Build scoreboard output
            const scoreboard = ranked.map((row: any, idx: number) => {
                const rankCell = row.find((c: any) => c.type === "rank");
                const userCell = row.find((c: any) => c.type === "user");
                const timeCell = row.find((c: any) => c.type === "time");
                const probCells = row.filter((c: any) => c.type === "record" || c.type === "problem");
                const uid = userCell?.raw;
                const udoc = udict[uid] || {};
                const timeParts = (timeCell?.value || "0\n0:00").split("\n");
                return {
                    rank: parseInt(rankCell?.value) || (idx + 1),
                    uid,
                    name: udoc.displayName || udoc.uname || ("Team " + uid),
                    school: udoc.school || "",
                    solved: parseInt(timeParts[0]) || 0,
                    penalty: timeParts[1] || "0:00",
                    problems: probCells.map((c: any) => ({
                        score: c.score || 0,
                        solved: c.score === 100,
                        value: c.value || "",
                        raw: c.raw || null,
                    })),
                };
            });

            // Leaderboard
            const leaderboard = scoreboard.slice(0, 8);

            // FTS
            const pdict = await ProblemModel.getList(domainId, tdoc.pids, true, false);
            const fts: any[] = [];
            const tsdocs = await ContestModel.getMultiStatus(domainId, { docId: tdoc._id }).toArray();
            for (let pi = 0; pi < tdoc.pids.length; pi++) {
                const pid = tdoc.pids[pi]; let first: any = null, firstTime = Infinity;
                for (const ts of tsdocs) {
                    if (ts.unrank) continue;
                    const journal = (ts.journal || []).filter((j: any) => j.pid === pid);
                    const acEntry = journal.find((j: any) => j.status === STATUS.STATUS_ACCEPTED);
                    if (acEntry) { const t = new ObjectId(acEntry.rid).getTimestamp().getTime(); if (t < firstTime) { firstTime = t; first = { uid: ts.uid, time: Math.floor((t - tdoc.beginAt.getTime()) / 60000) }; } }
                }
                if (first) {
                    const udoc = udict[first.uid];
                    fts.push({ solved: true, uid: first.uid, teamName: udoc ? (udoc.displayName || udoc.uname) : ("Team " + first.uid), time: first.time });
                } else { fts.push({ solved: false, uid: null }); }
            }

            // Judge queue
            const records = await coll.find({ domainId, contest: tid }).sort({ _id: -1 }).limit(30).project({ _id: 1, uid: 1, pid: 1, status: 1 }).toArray();
            const rowByUid: Record<number, any> = {};
            for (const r of scoreboard) rowByUid[r.uid] = r;

            const queue = records.map((r: any) => {
                const row = rowByUid[r.uid];
                const probIdx = tdoc.pids.indexOf(r.pid);
                const isPending = PENDING_STATUSES.includes(r.status);
                const isAccepted = r.status === STATUS.STATUS_ACCEPTED;
                const isFailed = FAIL_STATUSES.includes(r.status);
                return {
                    id: r._id.toString(), uid: r.uid,
                    rank: row ? row.rank : 0,
                    teamName: row ? row.name : ("U" + r.uid),
                    school: row ? row.school : "",
                    solved: row ? row.solved : 0,
                    penalty: row ? row.penalty : "0:00",
                    problems: row ? row.problems : [],
                    submitProbIdx: probIdx,
                    isPending, isAccepted, isFailed,
                    // Hide result during frozen
                    showResult: !ContestModel.isLocked(tdoc),
                };
            });

            const totalSubs = await coll.countDocuments({ domainId, contest: tid });
            const acSubs = await coll.countDocuments({ domainId, contest: tid, status: STATUS.STATUS_ACCEPTED });

            this.response.body = {
                phase, targetTime, title: tdoc.title,
                lockAt: tdoc.lockAt ? tdoc.lockAt.getTime() : null,
                beginAt: tdoc.beginAt.getTime(), endAt: tdoc.endAt.getTime(), serverTime: Date.now(),
                nProbs: tdoc.pids.length,
                probTitles: tdoc.pids.map((pid: number) => pdict[pid] ? pdict[pid].title : ("Problem " + pid)),
                scoreboard, leaderboard, fts, queue,
                stats: { totalSubs, acSubs, totalTeams: scoreboard.length, rankedTeams: scoreboard.length },
            };
            this.response.type = "application/json";
        }
    }

    ctx.Route("presentation_page", "/contest/:tid/presentation", PresentationPageHandler);
    ctx.Route("presentation_state", "/contest/:tid/presentation/state", PresentationStateHandler);
}