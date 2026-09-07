import * as echarts from "echarts/core";
import { CandlestickChart, LineChart, BarChart, HeatmapChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkPointComponent,
  ToolboxComponent,
  MarkLineComponent,
  MarkAreaComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  CandlestickChart, LineChart, BarChart, HeatmapChart,
  GridComponent, TooltipComponent, LegendComponent,
  DataZoomComponent, MarkPointComponent,
  ToolboxComponent, MarkLineComponent, MarkAreaComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

export const CHART_GROUP = "quant-charts";

let _connected = false;

export function connectCharts() {
  if (!_connected) {
    echarts.connect(CHART_GROUP);
    _connected = true;
  }
}

/** Named shape of an initialized chart — consumers import this, not ReturnType. */
export type EChartsInstance = echarts.ECharts;

/**
 * Minimal shape of the echarts axis-tooltip params our formatters read.
 * echarts' own CallbackDataParams is not part of the core bundle types, so the
 * ported charts normalize `unknown` params through this.
 */
export interface TooltipParam {
  axisValue?: string | number;
  seriesName?: string;
  marker?: string;
  value?: unknown;
}

export { echarts };
