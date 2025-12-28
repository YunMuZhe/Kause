import React from 'react';

interface InputField {
    key: string;
    label: string;
    type: 'string' | 'select' | 'boolean';
    placeholder?: string;
    default?: string;
    description?: string;
    options?: string[];
}

interface DynamicFormProps {
    fields: InputField[];
    values: Record<string, any>;
    onChange: (key: string, value: any) => void;
}

const DynamicForm: React.FC<DynamicFormProps> = ({ fields, values, onChange }) => {
    return (
        <div className="space-y-6">
            {fields.map((field) => (
                <div key={field.key} className="space-y-2">
                    <label className="text-sm font-medium text-slate-300 block">
                        {field.label}
                    </label>

                    {field.type === 'string' && (
                        <input
                            type="text"
                            value={values[field.key] || ''}
                            placeholder={field.placeholder}
                            onChange={(e) => onChange(field.key, e.target.value)}
                            className="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none transition-all"
                        />
                    )}

                    {field.type === 'select' && (
                        <select
                            value={values[field.key] || ''}
                            onChange={(e) => onChange(field.key, e.target.value)}
                            className="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none transition-all appearance-none"
                        >
                            <option value="" disabled>Select an option</option>
                            {field.options?.map(opt => (
                                <option key={opt} value={opt}>{opt}</option>
                            ))}
                        </select>
                    )}

                    {field.description && (
                        <p className="text-xs text-slate-500 italic">
                            {field.description}
                        </p>
                    )}
                </div>
            ))}
        </div>
    );
};

export default DynamicForm;
