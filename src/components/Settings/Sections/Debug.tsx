import { UIConfigField } from '@/lib/config/types';
import SettingsField from '../SettingsField';

const Debug = ({
  fields,
  values,
}: {
  fields: UIConfigField[];
  values: Record<string, any>;
}) => {
  return (
    <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
      {fields.map((field) => (
        <SettingsField
          key={field.key}
          field={field}
          value={
            (field.scope === 'client'
              ? localStorage.getItem(field.key)
              : /* A config file written before this section existed has no
                   debug key at all, so values can be undefined. */
                values?.[field.key]) ?? field.default
          }
          dataAdd="debug"
        />
      ))}
    </div>
  );
};

export default Debug;
