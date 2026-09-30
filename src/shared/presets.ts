// Comparison scenarios covering: branch add/remove, discriminator-value reuse,
// field optionality, nested unions, default branches, open unions and mapping
// order changes. `expectBackward` / `expectForward` document the intended
// verdict and are asserted by the test suite.

import { Schema } from './schema';

export interface Preset {
  id: string;
  label: string;
  description: string;
  v1: Schema;
  v2: Schema;
  policy: 'fail' | 'passthrough';
  expectBackward: boolean;
  expectForward: boolean;
}

const eventV1: Schema = {
  kind: 'union',
  discriminator: 'type',
  branches: [
    { value: 'created', payload: { kind: 'object', fields: { id: { schema: { kind: 'string' } } } } },
    { value: 'archived', payload: { kind: 'object' } },
  ],
};

export const presets: Preset[] = [
  {
    id: 'add-branch',
    label: '新增分支（判别值新增）',
    description: 'v2 增加了 merged 分支。旧消费者遇到 type:"merged" 直接拒绝——不应被标为完全兼容。',
    v1: eventV1,
    v2: {
      kind: 'union',
      discriminator: 'type',
      branches: [
        { value: 'created', payload: { kind: 'object', fields: { id: { schema: { kind: 'string' } } } } },
        { value: 'archived', payload: { kind: 'object' } },
        { value: 'merged', payload: { kind: 'object', fields: { mergedBy: { schema: { kind: 'string' } } } } },
      ],
    },
    policy: 'fail',
    expectBackward: false,
    expectForward: true,
  },
  {
    id: 'remove-branch',
    label: '删除分支',
    description: 'v2 删除了 archived 分支。新消费者读不出旧生产者仍在发送的 archived 事件。',
    v1: eventV1,
    v2: {
      kind: 'union',
      discriminator: 'type',
      branches: [
        { value: 'created', payload: { kind: 'object', fields: { id: { schema: { kind: 'string' } } } } },
      ],
    },
    policy: 'fail',
    expectBackward: true,
    expectForward: false,
  },
  {
    id: 'value-reuse',
    label: '判别值重用',
    description: 'created 的判别值在 v2 被重用为完全不同的负载（number id、必填 at）。分支名相同不代表兼容。',
    v1: eventV1,
    v2: {
      kind: 'union',
      discriminator: 'type',
      branches: [
        {
          value: 'created',
          payload: { kind: 'object', fields: { id: { schema: { kind: 'integer' } }, at: { schema: { kind: 'string' } } } },
        },
        { value: 'archived', payload: { kind: 'object' } },
      ],
    },
    policy: 'fail',
    expectBackward: false,
    expectForward: false,
  },
  {
    id: 'field-optional',
    label: '字段可选化',
    description: 'created.id 在 v2 变为可选。新生产者可能省略 id，旧消费者仍要求它（向后不兼容）；新消费者读旧数据没问题。',
    v1: eventV1,
    v2: {
      kind: 'union',
      discriminator: 'type',
      branches: [
        {
          value: 'created',
          payload: { kind: 'object', fields: { id: { optional: true, schema: { kind: 'string' } } } },
        },
        { value: 'archived', payload: { kind: 'object' } },
      ],
    },
    policy: 'fail',
    expectBackward: false,
    expectForward: true,
  },
  {
    id: 'rename-discriminator',
    label: '重命名判别字段',
    description: '判别字段 type 改名为 kind。只检查分支内部字段会漏掉它：两边负载都合法，但路由字段对不上。',
    v1: eventV1,
    v2: {
      kind: 'union',
      discriminator: 'kind',
      branches: [
        { value: 'created', payload: { kind: 'object', fields: { id: { schema: { kind: 'string' } } } } },
        { value: 'archived', payload: { kind: 'object' } },
      ],
    },
    policy: 'fail',
    expectBackward: false,
    expectForward: false,
  },
  {
    id: 'nested-union',
    label: '嵌套 union',
    description: 'created.detail 在 v2 新增 notify 嵌套判别值，差异必须带着穿过的 union 路径上报。',
    v1: {
      kind: 'union',
      discriminator: 'type',
      branches: [
        {
          value: 'created',
          payload: {
            kind: 'object',
            fields: {
              id: { schema: { kind: 'string' } },
              detail: {
                schema: {
                  kind: 'union',
                  discriminator: 'channel',
                  branches: [
                    { value: 'email', payload: { kind: 'object', fields: { to: { schema: { kind: 'string' } } } } },
                  ],
                },
              },
            },
          },
        },
      ],
    },
    v2: {
      kind: 'union',
      discriminator: 'type',
      branches: [
        {
          value: 'created',
          payload: {
            kind: 'object',
            fields: {
              id: { schema: { kind: 'string' } },
              detail: {
                schema: {
                  kind: 'union',
                  discriminator: 'channel',
                  branches: [
                    { value: 'email', payload: { kind: 'object', fields: { to: { schema: { kind: 'string' } } } } },
                    { value: 'sms', payload: { kind: 'object', fields: { phone: { schema: { kind: 'string' } } } } },
                  ],
                },
              },
            },
          },
        },
      ],
    },
    policy: 'fail',
    expectBackward: false,
    expectForward: true,
  },
  {
    id: 'default-branch',
    label: '默认分支（unknown: default）',
    description: 'v2 用 defaultPayload={note?} 兜底未知值；v1 仍是封闭 union。新增 merged 对旧消费者依旧失败，default 只救得了新消费者一侧。',
    v1: eventV1,
    v2: {
      kind: 'union',
      discriminator: 'type',
      branches: [
        { value: 'created', payload: { kind: 'object', fields: { id: { schema: { kind: 'string' } } } } },
        { value: 'archived', payload: { kind: 'object' } },
        { value: 'merged', payload: { kind: 'object', fields: { mergedBy: { schema: { kind: 'string' } } } } },
      ],
      unknown: { mode: 'default', defaultPayload: { kind: 'object', fields: { note: { optional: true, schema: { kind: 'string' } } } } },
    },
    policy: 'fail',
    expectBackward: false,
    expectForward: true,
  },
  {
    id: 'open-union',
    label: '开放 union（unknown: passthrough）',
    description: '两边都是 passthrough，v2 新增空负载的 merged 分支：旧消费者透传未知值，裸对象也满足新分支，双向兼容。',
    v1: {
      kind: 'union',
      discriminator: 'type',
      branches: [
        { value: 'created', payload: { kind: 'object', fields: { id: { schema: { kind: 'string' } } } } },
      ],
      unknown: { mode: 'passthrough' },
    },
    v2: {
      kind: 'union',
      discriminator: 'type',
      branches: [
        { value: 'created', payload: { kind: 'object', fields: { id: { schema: { kind: 'string' } } } } },
        { value: 'merged', payload: { kind: 'object' } },
      ],
      unknown: { mode: 'passthrough' },
    },
    policy: 'passthrough',
    expectBackward: true,
    expectForward: true,
  },
  {
    id: 'mapping-reorder',
    label: '映射顺序变化',
    description: 'v2 仅调整分支声明顺序，负载完全一致。顺序不影响路由，应双向完全兼容。',
    v1: eventV1,
    v2: {
      kind: 'union',
      discriminator: 'type',
      branches: [
        { value: 'archived', payload: { kind: 'object' } },
        { value: 'created', payload: { kind: 'object', fields: { id: { schema: { kind: 'string' } } } } },
      ],
    },
    policy: 'fail',
    expectBackward: true,
    expectForward: true,
  },
  {
    id: 'open-vs-explicit',
    label: '开放生产者 vs 显式新分支',
    description: 'v1 passthrough 可为任意值发裸对象；v2 为 merged 增加了要求负载的显式分支，向前不兼容。',
    v1: {
      kind: 'union',
      discriminator: 'type',
      branches: [
        { value: 'created', payload: { kind: 'object', fields: { id: { schema: { kind: 'string' } } } } },
      ],
      unknown: { mode: 'passthrough' },
    },
    v2: {
      kind: 'union',
      discriminator: 'type',
      branches: [
        { value: 'created', payload: { kind: 'object', fields: { id: { schema: { kind: 'string' } } } } },
        { value: 'merged', payload: { kind: 'object', fields: { mergedBy: { schema: { kind: 'string' } } } } },
      ],
      unknown: { mode: 'passthrough' },
    },
    policy: 'passthrough',
    expectBackward: true,
    expectForward: false,
  },
];
