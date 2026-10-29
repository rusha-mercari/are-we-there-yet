export type Tracked = {
  id: string
  type: string
  description: string
  /** The first part of the task prompt, shown when a card is expanded. */
  brief?: string
  startedAt: number
  steps: number
  lastTool: string | null
  /** The last few tools, newest last. */
  recentTools?: string[]
  expectedMs: number
  expectedSteps: number
  /** How many finished runs of this type the guess was learned from. */
  samples: number
  /** The furthest the bar has got, so it never moves back. */
  maxProgress?: number
  /** Consecutive ticks the agent was absent from `$.agent.list()`. */
  missingTicks?: number
  /** Model requests the agent has made so far. */
  modelRequests?: number
  /** The current response is long prose with no tool call: likely the final report. */
  isWrappingUp?: boolean
}

export type Finished = {
  id: string
  type: string
  description: string
  elapsedMs: number
  predictedMs: number
  status: string
  at: number
}

export type History = { n: number; avgMs: number; avgSteps: number }

declare module 'claude-code' {
  interface PluginState {
    'are-we-there-yet': {
      agents: Record<string, Tracked>
      done: Finished[]
      history: Record<string, History>
      expanded: string | null
      showArrived: boolean
      showRecord: boolean
      now: number
      isHidden: boolean
    }
  }
}
