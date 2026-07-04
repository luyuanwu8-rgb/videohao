// 安全验证:在临时假数据根上测清理逻辑,绝不碰真实 data/。
import { mkdir, writeFile, utimes, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = join(tmpdir(), "videohao-cleanup-test-" + Date.now());
process.env.DATA_ROOT = root; // 关键:改指假根,再动态 import cleanup
const tasksRoot = join(root, "tasks");
const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const { sweepWorkDirs, deleteTaskFiles, safeTaskDir, isValidTaskId, registerActiveWorkDir } = await import("@/lib/cleanup");

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`  ${cond ? "PASS" : "FAIL ❌"}  ${name}`); };
const mk = async (dir: string, files: string[] = []) => { await mkdir(dir, { recursive: true }); for (const f of files) await writeFile(join(dir, f), "x".repeat(2048)); };
const old = (p: string) => { const t = (Date.now() - 3600_000) / 1000; return utimes(p, t, t); }; // 1小时前

// ---- 造假数据 ----
await mk(join(tasksRoot, A, "renders", "ffwork-old1"), ["clip.mp4", "video.mp4"]); await old(join(tasksRoot, A, "renders", "ffwork-old1"));
await mk(join(tasksRoot, A, "renders", "work-old2"), ["f.png"]);                    await old(join(tasksRoot, A, "renders", "work-old2"));
await mk(join(tasksRoot, A, "renders", "ffwork-fresh"), ["f.png"]);                 // 新建(不设旧时间)
await mk(join(tasksRoot, A, "renders", "ffwork-active"), ["f.png"]);                await old(join(tasksRoot, A, "renders", "ffwork-active"));
await mk(join(tasksRoot, A, "images"), ["1.png", "2.png"]);
await writeFile(join(tasksRoot, A, "final.mp4"), "PRODUCT");
await writeFile(join(tasksRoot, A, "renders", "cinematic.mp4"), "PRODUCT-GALLERY"); // 成品文件,必须活
await mk(join(tasksRoot, B, "renders", "ffwork-bold"), ["x.mp4"]);                  await old(join(tasksRoot, B, "renders", "ffwork-bold"));
await writeFile(join(tasksRoot, B, "final.mp4"), "B-PRODUCT");

// ---- 测 1:sweep 保护活动目录 + 只删旧废料子目录,成品/图片不碰 ----
registerActiveWorkDir(join(tasksRoot, A, "renders", "ffwork-active"));
const r = await sweepWorkDirs(); // 默认 minAgeMs=5min
console.log(`sweep 删了 ${r.dirs} 个目录, ${Math.round(r.bytes/1024)}KB`);
check("旧 ffwork-old1 已删", !existsSync(join(tasksRoot, A, "renders", "ffwork-old1")));
check("旧 work-old2 已删", !existsSync(join(tasksRoot, A, "renders", "work-old2")));
check("B 的旧 ffwork-bold 也删(全局清理)", !existsSync(join(tasksRoot, B, "renders", "ffwork-bold")));
check("新建 ffwork-fresh 受年龄保护未删", existsSync(join(tasksRoot, A, "renders", "ffwork-fresh")));
check("登记的 ffwork-active 受活动保护未删", existsSync(join(tasksRoot, A, "renders", "ffwork-active")));
check("成品 cinematic.mp4(文件)未删", existsSync(join(tasksRoot, A, "renders", "cinematic.mp4")));
check("成品 final.mp4 未删", existsSync(join(tasksRoot, A, "final.mp4")));
check("图片目录 images/ 未删", existsSync(join(tasksRoot, A, "images", "1.png")));
check("B 的 final.mp4 未删", existsSync(join(tasksRoot, B, "final.mp4")));

// ---- 测 2:路径安全校验(坏 ID 一律拒绝) ----
check("isValidTaskId 拒绝空串", !isValidTaskId(""));
check("isValidTaskId 拒绝 ../ 越界", !isValidTaskId("../../etc"));
check("isValidTaskId 接受合法UUID", isValidTaskId(A));
let threw = false; try { safeTaskDir("../../../windows"); } catch { threw = true; } check("safeTaskDir 对越界路径抛错", threw);
threw = false; try { safeTaskDir(""); } catch { threw = true; } check("safeTaskDir 对空ID抛错", threw);

// ---- 测 3:deleteTaskFiles 只删目标任务,隔壁任务完好 ----
const del = await deleteTaskFiles(A);
console.log(`deleteTaskFiles(A) 释放 ${Math.round(del.bytes/1024)}KB`);
check("任务A 目录已整删", !existsSync(join(tasksRoot, A)));
check("隔壁任务B 完好无损", existsSync(join(tasksRoot, B, "final.mp4")));
let threw2 = false; try { await deleteTaskFiles("../../../etc"); } catch { threw2 = true; } check("deleteTaskFiles 对坏ID抛错(不删)", threw2);

console.log(`\n==== 结果:${pass} 通过 / ${fail} 失败 ====`);
// 清理测试临时目录
await import("node:fs/promises").then(m => m.rm(root, { recursive: true, force: true })).catch(() => {});
process.exit(fail === 0 ? 0 : 1);
