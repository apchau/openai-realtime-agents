"use client";

import React, { createContext, useContext, useState, FC, PropsWithChildren } from "react";
import { v4 as uuidv4 } from "uuid";
import { LoggedEvent, UsageCostLogger, UsageLogPayload, UsageCostTotals } from "@/app/types";
import {
  accumulateTotals,
  calculateUsageCost,
  emptyUsageTotals,
  getPricingForModel,
  normalizeUsage,
} from "@/app/lib/cost";

type EventContextValue = {
  loggedEvents: LoggedEvent[];
  logClientEvent: (eventObj: Record<string, any>, eventNameSuffix?: string) => void;
  logServerEvent: (eventObj: Record<string, any>, eventNameSuffix?: string) => void;
  logHistoryItem: (item: any) => void;
  toggleExpand: (id: number | string) => void;
  usageTotals: Record<string, UsageCostTotals>;
  logUsageCost: UsageCostLogger;
};

const EventContext = createContext<EventContextValue | undefined>(undefined);

export const EventProvider: FC<PropsWithChildren> = ({ children }) => {
  const [loggedEvents, setLoggedEvents] = useState<LoggedEvent[]>([]);
  const [usageTotals, setUsageTotals] = useState<Record<string, UsageCostTotals>>({});

  function addLoggedEvent(direction: "client" | "server", eventName: string, eventData: Record<string, any>) {
    const id = eventData.event_id || uuidv4();
    setLoggedEvents((prev) => [
      ...prev,
      {
        id,
        direction,
        eventName,
        eventData,
        timestamp: new Date().toLocaleTimeString(),
        expanded: false,
      },
    ]);
  }

  const logClientEvent: EventContextValue["logClientEvent"] = (eventObj, eventNameSuffix = "") => {
    const name = `${eventObj.type || ""} ${eventNameSuffix || ""}`.trim();
    addLoggedEvent("client", name, eventObj);
  };

  const logServerEvent: EventContextValue["logServerEvent"] = (eventObj, eventNameSuffix = "") => {
    const name = `${eventObj.type || ""} ${eventNameSuffix || ""}`.trim();
    addLoggedEvent("server", name, eventObj);
  };

  const logHistoryItem: EventContextValue['logHistoryItem'] = (item) => {
    let eventName = item.type;
    if (item.type === 'message') {
      eventName = `${item.role}.${item.status}`;
    }
    if (item.type === 'function_call') {
      eventName = `function.${item.name}.${item.status}`;
    }
    addLoggedEvent('server', eventName, item);
  };

  const toggleExpand: EventContextValue['toggleExpand'] = (id) => {
    setLoggedEvents((prev) =>
      prev.map((log) => {
        if (log.id === id) {
          return { ...log, expanded: !log.expanded };
        }
        return log;
      })
    );
  };

  const logUsageCost: EventContextValue['logUsageCost'] = (payload: UsageLogPayload) => {
    if (!payload) return;
    const usageDelta = normalizeUsage(payload.usage);
    if (
      usageDelta.inputTokens === 0 &&
      usageDelta.outputTokens === 0 &&
      usageDelta.totalTokens === 0
    ) {
      return;
    }

    setUsageTotals((prev) => {
      const pricingInfo = getPricingForModel(payload.model);
      const resolvedModel = pricingInfo?.resolvedModel ?? payload.model;
      const pricing = pricingInfo?.pricing;
      const existingTotals = prev[resolvedModel] ?? emptyUsageTotals();
      const costDelta = pricing ? calculateUsageCost(usageDelta, pricing) : null;
      const updatedTotals = accumulateTotals(existingTotals, usageDelta, costDelta);
      const nextTotals = {
        ...prev,
        [resolvedModel]: updatedTotals,
      };

      const overallTotals = Object.values(nextTotals).reduce<UsageCostTotals>(
        (acc, totals) => ({
          inputTokens: acc.inputTokens + totals.inputTokens,
          outputTokens: acc.outputTokens + totals.outputTokens,
          totalTokens: acc.totalTokens + totals.totalTokens,
          inputCost: acc.inputCost + totals.inputCost,
          outputCost: acc.outputCost + totals.outputCost,
          totalCost: acc.totalCost + totals.totalCost,
        }),
        emptyUsageTotals(),
      );

      addLoggedEvent(
        "server",
        `usage_cost.${payload.source || "usage"}`,
        {
          model: payload.model,
          resolvedModel,
          source: payload.source,
          usageDelta,
          deltaCostUSD: costDelta,
          pricing: pricing ?? null,
          totalsForModel: updatedTotals,
          totalsOverall: overallTotals,
          pricingAvailable: Boolean(pricing),
          metadata: payload.metadata ?? {},
        },
      );

      return nextTotals;
    });
  };


  return (
    <EventContext.Provider
      value={{
        loggedEvents,
        logClientEvent,
        logServerEvent,
        logHistoryItem,
        toggleExpand,
        usageTotals,
        logUsageCost,
      }}
    >
      {children}
    </EventContext.Provider>
  );
};

export function useEvent() {
  const context = useContext(EventContext);
  if (!context) {
    throw new Error("useEvent must be used within an EventProvider");
  }
  return context;
}