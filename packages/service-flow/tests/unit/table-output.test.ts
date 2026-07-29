import { describe, expect, it } from 'vitest';
import { renderTraceTable } from '../../src/output/table-output.js';
import type { TraceResult } from '../../src/types.js';

describe('trace table output', () => {
  it('widens columns so identifiers are never silently truncated', () => {
    const result: TraceResult = {
      start: {},
      nodes: [],
      diagnostics: [],
      edges: [{
        step: 1,
        type: 'operation_implemented_by_handler',
        from: 'repository:service:operation:with:a:very:long:source',
        to: 'repository:src/handlers/VeryLongHandler.executeOperation',
        evidence: {},
        confidence: 1,
      }],
    };

    const table = renderTraceTable(result);

    expect(table).toContain('operation_implemented_by_handler');
    expect(table).toContain(
      'repository:service:operation:with:a:very:long:source',
    );
    expect(table).toContain(
      'repository:src/handlers/VeryLongHandler.executeOperation',
    );
    expect(table).not.toContain('…');
  });

  it('discloses proof only for an unproven receiver certainty', () => {
    const evidence = {
      file: 'srv/helpers/emit.ts',
      sourceLine: 252,
      dispatchScope: 'workspace_event_name_only',
      outboundEvidence: {
        receiverProof: 'parameter_flow',
        rootReceiver: 'messaging',
      },
    };
    const result: TraceResult = {
      start: {},
      nodes: [],
      diagnostics: [],
      edges: [
        {
          step: 1,
          type: 'async_emit',
          from: 'call:1',
          to: 'event:Unproven',
          evidence: {
            ...evidence,
            dispatchCertainty: 'receiver_unproven',
          },
          confidence: 0.5,
        },
        {
          step: 2,
          type: 'async_emit',
          from: 'call:2',
          to: 'event:Static',
          evidence: {
            ...evidence,
            dispatchCertainty: 'static_name_only',
          },
          confidence: 0.8,
        },
      ],
    };

    const table = renderTraceTable(result);

    expect(table).toContain(
      'certainty=receiver_unproven,proof=parameter_flow(messaging)',
    );
    expect(table.match(/proof=parameter_flow\(messaging\)/g)).toHaveLength(1);
  });
});
