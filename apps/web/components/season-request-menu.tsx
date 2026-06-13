"use client";

import { Check, ChevronDown, LoaderCircle, Plus } from "lucide-react";
import { useState, useTransition } from "react";
import {
  requestRemainingAction,
  requestSeasonAction,
  type RequestTrackingActionResult,
} from "../app/actions";
import { isLockedResult, RequestedBadge } from "./request-state";

/**
 * Two-step acquisition entry for a tv title: the dropdown only SELECTS a
 * scope (all remaining seasons, or one specific season) and rewrites the
 * pill label; nothing is queued until the pill itself is pressed. Seasons
 * that are already tracked are not offered — `seasonNumbers` must be the
 * untracked ones.
 */
export function SeasonRequestMenu({
  tmdbId,
  seasonNumbers,
  allLabel = "获取所有季",
}: {
  tmdbId: number;
  /** Seasons still available to request (untracked only). */
  seasonNumbers: number[];
  /** Pill label for the all-remaining scope. */
  allLabel?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number | "all">("all");
  const [result, setResult] = useState<RequestTrackingActionResult | null>(null);

  if (isLockedResult(result)) {
    return <RequestedBadge title={result?.message} />;
  }

  const submit = () => {
    startTransition(async () => {
      setOpen(false);
      setResult(
        selected === "all"
          ? await requestRemainingAction({ tmdbId })
          : await requestSeasonAction({ tmdbId, seasonNumber: selected }),
      );
    });
  };

  if (seasonNumbers.length <= 1) {
    const onlySeason = seasonNumbers[0] ?? 1;
    return (
      <button
        className="primary-button"
        type="button"
        disabled={isPending}
        onClick={() => {
          startTransition(async () => {
            setResult(await requestSeasonAction({ tmdbId, seasonNumber: onlySeason }));
          });
        }}
      >
        {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Plus size={14} aria-hidden />}
        获取
      </button>
    );
  }

  return (
    <div className="season-menu">
      <button className="primary-button" type="button" disabled={isPending} onClick={submit}>
        {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Plus size={14} aria-hidden />}
        {selected === "all" ? allLabel : `获取第 ${selected} 季`}
      </button>
      <button
        className="season-menu-toggle"
        type="button"
        aria-label="选择获取范围"
        aria-expanded={open}
        disabled={isPending}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown size={14} aria-hidden />
      </button>
      {open ? (
        <ul className="season-menu-list" role="menu">
          <li role="none">
            <button
              role="menuitemradio"
              aria-checked={selected === "all"}
              type="button"
              onClick={() => {
                setSelected("all");
                setOpen(false);
              }}
            >
              {selected === "all" ? <Check size={13} aria-hidden /> : <span className="menu-spacer" />}
              {allLabel}
            </button>
          </li>
          {seasonNumbers.map((seasonNumber) => (
            <li key={seasonNumber} role="none">
              <button
                role="menuitemradio"
                aria-checked={selected === seasonNumber}
                type="button"
                onClick={() => {
                  setSelected(seasonNumber);
                  setOpen(false);
                }}
              >
                {selected === seasonNumber ? (
                  <Check size={13} aria-hidden />
                ) : (
                  <span className="menu-spacer" />
                )}
                第 {seasonNumber} 季
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
