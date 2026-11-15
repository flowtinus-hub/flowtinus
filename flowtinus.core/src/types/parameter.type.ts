type ParameterValueByType = { text: string; number: number; boolean: boolean };

export type ParameterType = keyof ParameterValueByType;
export type ParameterValue = ParameterValueByType[ParameterType];
