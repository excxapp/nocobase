import { defaultProps } from './properties';
import { IField } from './types';

export const time: IField = {
  name: 'time',
  type: 'object',
  group: 'datetime',
  order: 2,
  title: '{{t("Time")}}',
  sortable: true,
  default: {
    type: 'time',
    // name,
    uiSchema: {
      type: 'string',
      'x-component': 'TimePicker',
    },
  },
  properties: {
    ...defaultProps,
    'uiSchema.x-component-props.format': {
      type: 'string',
      title: '{{t("Time format")}}',
      'x-component': 'Radio.Group',
      'x-decorator': 'FormItem',
      default: 'HH:mm:ss',
      enum: [
        {
          label: '{{t("12 hour")}}',
          value: 'hh:mm:ss a',
        },
        {
          label: '{{t("24 hour")}}',
          value: 'HH:mm:ss',
        },
      ],
    },
  },
  operators: [
    { label: '{{t("is")}}', value: '$eq', selected: true },
    { label: '{{t("is not")}}', value: '$neq' },
    { label: '{{t("is empty")}}', value: '$null', noValue: true },
    { label: '{{t("is not empty")}}', value: '$notNull', noValue: true },
  ],
};