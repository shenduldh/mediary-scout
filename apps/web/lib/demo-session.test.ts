import { describe, expect, it } from "vitest";
import { listDemoAcquisitions, recordDemoAcquisition, demoCompletedItems, type DemoAcquisitionEntry } from "./demo-session";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    _map: map,
  };
}

const entry = (tmdbId: number, title = `T${tmdbId}`): DemoAcquisitionEntry => ({
  tmdbId,
  title,
  year: 2020,
  type: "movie",
  posterPath: "/p.jpg",
});

describe("demo-session", () => {
  it("records then lists the entry", () => {
    const s = fakeStorage();
    recordDemoAcquisition(entry(1), s);
    expect(listDemoAcquisitions(s).map((e) => e.tmdbId)).toEqual([1]);
  });

  it("dedups by tmdbId and moves the re-recorded one to the front", () => {
    const s = fakeStorage();
    recordDemoAcquisition(entry(1), s);
    recordDemoAcquisition(entry(2), s);
    recordDemoAcquisition(entry(1, "again"), s);
    const list = listDemoAcquisitions(s);
    expect(list.map((e) => e.tmdbId)).toEqual([1, 2]);
    expect(list[0]!.title).toBe("again");
  });

  it("caps at 20 (newest first)", () => {
    const s = fakeStorage();
    for (let i = 1; i <= 25; i++) recordDemoAcquisition(entry(i), s);
    const list = listDemoAcquisitions(s);
    expect(list).toHaveLength(20);
    expect(list[0]!.tmdbId).toBe(25);
  });

  it("malformed / non-array JSON → empty list", () => {
    expect(listDemoAcquisitions(fakeStorage({ "mediary-demo-acquired": "not json" }))).toEqual([]);
    expect(listDemoAcquisitions(fakeStorage({ "mediary-demo-acquired": '{"a":1}' }))).toEqual([]);
  });

  it("drops entries with the wrong shape", () => {
    const bad = JSON.stringify([{ tmdbId: "x" }, entry(7)]);
    expect(listDemoAcquisitions(fakeStorage({ "mediary-demo-acquired": bad })).map((e) => e.tmdbId)).toEqual([7]);
  });

  it("null storage (SSR) → empty list, record is a no-op (no throw)", () => {
    expect(listDemoAcquisitions(null)).toEqual([]);
    expect(() => recordDemoAcquisition(entry(1), null)).not.toThrow();
  });
});

describe("demoCompletedItems", () => {
  it("empty → []", () => {
    expect(demoCompletedItems([])).toEqual([]);
  });
  it("maps entries to completed activity items (status complete, demo runId)", () => {
    const items = demoCompletedItems([
      { tmdbId: 27205, title: "盗梦空间", year: 2010, type: "movie", posterPath: "/p.jpg" },
    ]);
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect(it0.workflowRunId).toBe("demo-27205");
    expect(it0.title).toBe("盗梦空间");
    expect(it0.status).toBe("complete");
    expect(it0.posterPath).toBe("/p.jpg");
    expect(it0.seasonLabel).toBeNull();
    expect(it0.sizeText).toBeNull();
    expect(typeof it0.createdAt).toBe("string");
  });
});
