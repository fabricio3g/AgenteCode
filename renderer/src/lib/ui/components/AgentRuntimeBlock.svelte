<script lang="ts">
  // AgentRuntimeBlock is intentionally minimal.
  // All agent status is communicated via AgentTimeline.
  // This component is kept for API compatibility but renders nothing.
  interface Props {
    mode?: 'chat' | 'slides' | 'agent';
    messageStatus?: 'idle' | 'streaming' | 'error';
    agentTaskId?: string | null;
    stepCount?: number;
    hasArtifact?: boolean;
    workspaceBound?: boolean;
  }

  let { mode = 'chat', messageStatus = 'idle', agentTaskId = null, stepCount = 0, hasArtifact = false, workspaceBound = false }: Props = $props();
</script>
