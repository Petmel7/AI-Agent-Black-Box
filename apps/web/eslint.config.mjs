import { baseConfig } from '@blackbox/config/eslint/base';
import nextVitals from 'eslint-config-next/core-web-vitals';

const config = [...baseConfig, ...nextVitals];

export default config;
