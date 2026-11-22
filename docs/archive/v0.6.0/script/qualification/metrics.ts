import type { Route, ApprovalResult } from "../../src/rpc"
import type { Case, Plan } from "./plan"

export type Sample = {
  id: string
  split: Case["split"]
  outcome: "succeeded" | "failed" | "cancelled"
  elapsedMs: number
  textMatch?: boolean
  textComparison?: {
    assistantPresent: boolean
    textParts: number
    actualLength: number
    expectedLength: number
    actualSha256: string
    expectedSha256: string
    firstDifference?: { utf16Offset: number; actualCodePoint: number | null; expectedCodePoint: number | null }
  }
  toolExpectationMet?: boolean
  toolCalls: number
  toolMatches: number
  manualReplies: number
  steps: number
  routes: Route[]
  approvals: ApprovalResult[]
}

const rate = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  value: denominator ? numerator / denominator : null,
})

/** Empirical labeled counts, not calibrated probabilities or production error bounds. */
export function metrics(plan: Plan, samples: readonly Sample[]) {
  return Object.fromEntries(
    ["tuning", "holdout"].map((split) => {
      const selected = samples.filter((sample) => sample.split === split)
      const completion = selected.filter((sample) => sample.textMatch !== undefined)
      const routes = selected.flatMap((sample) => {
        const item = plan.cases.find((item) => item.id === sample.id)
        if (!item) throw new Error("Unknown qualification sample")
        return sample.routes.filter((route) => route.kind === "primary").map((route) => ({ item, route }))
      })
      const labeledRoutes = routes.filter(({ item, route }) => item.acceptableTiers.length && route.tier)
      const resources = routes.flatMap(({ item, route }) => {
        const diagnostic = route.resources
        return diagnostic && item.contextSelection !== "inherit"
          ? item.resources.map((resource) => ({
              needed: resource.needed,
              omitted: (item.contextSelection === "shadow" ? diagnostic.proposed : diagnostic.omitted).includes(
                resource.id,
              ),
            }))
          : []
      })
      const approvals = selected.flatMap((sample) => {
        const item = plan.cases.find((item) => item.id === sample.id)
        if (!item) throw new Error("Unknown qualification sample")
        const threshold = plan.profile.approval?.tauAllow
        return sample.approvals.flatMap((approval) =>
          item.tool && threshold !== undefined
            ? [
                {
                  needsHuman: item.tool.needsHuman,
                  allow: approval.probability !== undefined && approval.probability < threshold,
                  hasProbability: approval.probability !== undefined,
                  actualAllow: approval.outcome === "allowed",
                },
              ]
            : [],
        )
      })
      const needsHuman = approvals.filter((approval) => approval.needsHuman)
      const allowed = approvals.filter((approval) => approval.allow)
      const wrongAllow = allowed.filter((approval) => approval.needsHuman).length
      const omitted = resources.filter((resource) => resource.omitted)
      return [
        split,
        {
          planned: plan.cases.filter((item) => item.split === split).length,
          samples: selected.length,
          completionExactMatch: rate(
            completion.filter((sample) => sample.textMatch && sample.outcome === "succeeded").length,
            completion.length,
          ),
          routingLabelMismatch: rate(
            labeledRoutes.filter(
              ({ item, route }) => route.tier !== undefined && !item.acceptableTiers.includes(route.tier),
            ).length,
            labeledRoutes.length,
          ),
          resources: {
            wrongOmissionsAmongNeeded: rate(
              omitted.filter((resource) => resource.needed).length,
              resources.filter((resource) => resource.needed).length,
            ),
            wrongOmissionsAmongOmitted: rate(omitted.filter((resource) => resource.needed).length, omitted.length),
            omissionCoverage: rate(omitted.length, resources.length),
          },
          approval: {
            labeledDecisions: approvals.length,
            probabilityCoverage: rate(approvals.filter((approval) => approval.hasProbability).length, approvals.length),
            falseNegativeRate: rate(wrongAllow, needsHuman.length),
            wrongAmongProposedAllow: rate(wrongAllow, allowed.length),
            proposedAllowCoverage: rate(allowed.length, approvals.length),
            actualAutoAllowCoverage: rate(
              approvals.filter((approval) => approval.actualAllow).length,
              approvals.length,
            ),
            manualRate: rate(approvals.filter((approval) => !approval.actualAllow).length, approvals.length),
            manualReplies: selected.reduce((sum, sample) => sum + sample.manualReplies, 0),
          },
          calibration: "not-qualified",
        },
      ]
    }),
  )
}
