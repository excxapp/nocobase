import { Checkbox, message, Table } from 'antd';
import React, { useState } from 'react';
import { useAPIClient, useRequest } from '../../api-client';
import { useRecord } from '../../record-provider';
import { useMenuItems } from './RoleTable';

const findUids = (items) => {
  if (!Array.isArray(items)) {
    return [];
  }
  const uids = [];
  for (const item of items) {
    uids.push(item.uid);
    uids.push(...findUids(item.children));
  }
  return uids;
};

export const MenuConfigure = () => {
  const record = useRecord();
  const api = useAPIClient();
  const items = useMenuItems();
  const allUids = findUids(items);
  const [uids, setUids] = useState([]);
  const { loading, refresh } = useRequest(
    {
      resource: 'roles.menuUiSchemas',
      resourceOf: record.name,
      action: 'list',
      params: {
        paginate: false,
      },
    },
    {
      onSuccess(data) {
        setUids(data?.data?.map((schema) => schema['x-uid']) || []);
      },
    },
  );
  const resource = api.resource('roles.menuUiSchemas', record.name);
  const allChecked = allUids.length === uids.length;
  return (
    <Table
      loading={loading}
      rowKey={'uid'}
      pagination={false}
      expandable={{
        defaultExpandAllRows: true,
      }}
      columns={[
        {
          dataIndex: 'title',
          title: '菜单项',
        },
        {
          dataIndex: 'accessible',
          title: (
            <>
              <Checkbox
                checked={allChecked}
                onChange={async (value) => {
                  if (allChecked) {
                    await resource.set({
                      values: [],
                    });
                  } else {
                    await resource.set({
                      values: allUids,
                    });
                  }
                  refresh();
                  message.success('保存成功');
                }}
              />{' '}
              允许访问
            </>
          ),
          render: (_, schema) => {
            const checked = uids.includes(schema.uid);
            return (
              <Checkbox
                checked={checked}
                onChange={async (e) => {
                  if (checked) {
                    const index = uids.indexOf(schema.uid);
                    uids.splice(index, 1);
                    setUids([...uids]);
                  } else {
                    setUids((prev) => [...prev, schema.uid]);
                  }
                  await resource.toggle({
                    values: {
                      tk: schema.uid,
                    },
                  });
                  message.success('保存成功');
                }}
              />
            );
          },
        },
      ]}
      dataSource={items}
    />
  );
};