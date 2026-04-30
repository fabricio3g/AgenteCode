import { z } from 'zod';
import { createLibrary, defineComponent, type ComponentGroup, type PromptOptions } from './library';
import Stack from './components/Stack.svelte';
import Card from './components/Card.svelte';
import ChatCard from './components/ChatCard.svelte';
import CardHeader from './components/CardHeader.svelte';
import TextContent from './components/TextContent.svelte';
import MarkdownRenderer from './components/MarkdownRenderer.svelte';
import Callout from './components/Callout.svelte';
import TextCallout from './components/TextCallout.svelte';
import ImageBlock from './components/ImageBlock.svelte';
import ImageGallery from './components/ImageGallery.svelte';
import CodeBlock from './components/CodeBlock.svelte';
import Table from './components/Table.svelte';
import TagBlock from './components/TagBlock.svelte';
import Button from './components/Button.svelte';
import Buttons from './components/Buttons.svelte';
import Form from './components/Form.svelte';
import FormControl from './components/FormControl.svelte';
import Input from './components/Input.svelte';
import TextArea from './components/TextArea.svelte';
import Select from './components/Select.svelte';
import DatePicker from './components/DatePicker.svelte';
import Slider from './components/Slider.svelte';
import CheckBoxGroup from './components/CheckBoxGroup.svelte';
import RadioGroup from './components/RadioGroup.svelte';
import SwitchGroup from './components/SwitchGroup.svelte';
import Tabs from './components/Tabs.svelte';
import Accordion from './components/Accordion.svelte';
import Steps from './components/Steps.svelte';
import Carousel from './components/Carousel.svelte';
import Separator from './components/Separator.svelte';
import ListBlock from './components/ListBlock.svelte';
import FollowUpBlock from './components/FollowUpBlock.svelte';
import SectionBlock from './components/SectionBlock.svelte';
import Chart from './components/Chart.svelte';
import Unknown from './components/Unknown.svelte';

const anyChild = z.any();
const anyArray = z.array(z.any());
const anyObject = z.record(z.string(), z.any()).optional();
const actionSchema = z.object({ type: z.string().optional(), params: z.record(z.string(), z.any()).optional() }).optional();
const optionSchema = z.any();

const StackComponent = defineComponent({
  name: 'Stack',
  props: z.object({ children: anyArray, direction: z.string().optional(), gap: z.string().optional(), align: z.string().optional(), justify: z.string().optional(), wrap: z.boolean().optional() }),
  description: 'Flexible vertical or horizontal stack layout.',
  component: Stack
});
const CardComponent = defineComponent({ name: 'Card', props: z.object({ children: anyArray }), description: 'Content card container.', component: Card });
const CardHeaderComponent = defineComponent({ name: 'CardHeader', props: z.object({ title: z.string(), subtitle: z.string().optional() }), description: 'Card title and subtitle.', component: CardHeader });
const TextContentComponent = defineComponent({ name: 'TextContent', props: z.object({ text: z.string(), tone: z.string().optional() }), description: 'Plain text content.', component: TextContent });
const MarkdownComponent = defineComponent({ name: 'MarkDownRenderer', props: z.object({ content: z.string() }), description: 'Markdown content block.', component: MarkdownRenderer });
const CalloutComponent = defineComponent({ name: 'Callout', props: z.object({ tone: z.string(), title: z.string().optional(), content: z.string() }), description: 'Highlighted message.', component: Callout });
const TextCalloutComponent = defineComponent({ name: 'TextCallout', props: z.object({ text: z.string() }), description: 'Simple emphasis callout.', component: TextCallout });
const ImageComponent = defineComponent({ name: 'Image', props: z.object({ src: z.string(), alt: z.string().optional(), caption: z.string().optional() }), description: 'Display an image.', component: ImageBlock });
const ImageBlockComponent = defineComponent({ name: 'ImageBlock', props: z.object({ src: z.string(), alt: z.string().optional(), caption: z.string().optional() }), description: 'Image block with caption.', component: ImageBlock });
const ImageGalleryComponent = defineComponent({ name: 'ImageGallery', props: z.object({ images: anyArray }), description: 'Responsive image gallery.', component: ImageGallery });
const CodeBlockComponent = defineComponent({ name: 'CodeBlock', props: z.object({ code: z.string(), language: z.string().optional() }), description: 'Code block display.', component: CodeBlock });
const ColComponent = defineComponent({ name: 'Col', props: z.object({ label: z.string(), kind: z.string().optional() }), description: 'Table column definition.', component: Unknown });
const TableComponent = defineComponent({ name: 'Table', props: z.object({ columns: anyArray, rows: anyArray }), description: 'Tabular data.', component: Table });
const TagComponent = defineComponent({ name: 'Tag', props: z.object({ label: z.string() }), description: 'Single tag token.', component: Unknown });
const TagBlockComponent = defineComponent({ name: 'TagBlock', props: z.object({ tags: anyArray }), description: 'Collection of tags.', component: TagBlock });
const ButtonComponent = defineComponent({ name: 'Button', props: z.object({ label: z.string(), action: actionSchema, variant: z.string().optional() }), description: 'Interactive button.', component: Button });
const ButtonsComponent = defineComponent({ name: 'Buttons', props: z.object({ items: anyArray }), description: 'Row of buttons.', component: Buttons });
const FormComponent = defineComponent({ name: 'Form', props: z.object({ name: z.string(), buttons: anyChild, fields: anyArray }), description: 'Interactive form container.', component: Form });
const FormControlComponent = defineComponent({ name: 'FormControl', props: z.object({ label: z.string(), control: anyChild }), description: 'Form field with label.', component: FormControl });
const LabelComponent = defineComponent({ name: 'Label', props: z.object({ text: z.string() }), description: 'Standalone form label.', component: TextContent });
const InputComponent = defineComponent({ name: 'Input', props: z.object({ name: z.string(), placeholder: z.string().optional(), inputType: z.string().optional(), rules: anyObject }), description: 'Text input field.', component: Input });
const TextAreaComponent = defineComponent({ name: 'TextArea', props: z.object({ name: z.string(), placeholder: z.string().optional(), rows: z.number().optional(), rules: anyObject }), description: 'Multiline text area.', component: TextArea });
const SelectItemComponent = defineComponent({ name: 'SelectItem', props: z.object({ value: z.string(), label: z.string() }), description: 'Select option item.', component: Unknown });
const SelectComponent = defineComponent({ name: 'Select', props: z.object({ name: z.string(), options: z.array(optionSchema), placeholder: z.string().optional(), rules: anyObject }), description: 'Select menu field.', component: Select });
const DatePickerComponent = defineComponent({ name: 'DatePicker', props: z.object({ name: z.string(), placeholder: z.string().optional(), rules: anyObject }), description: 'Date input field.', component: DatePicker });
const SliderComponent = defineComponent({ name: 'Slider', props: z.object({ name: z.string(), min: z.number().optional(), max: z.number().optional(), step: z.number().optional(), defaultValue: z.number().optional(), rules: anyObject }), description: 'Range slider.', component: Slider });
const CheckBoxItemComponent = defineComponent({ name: 'CheckBoxItem', props: z.object({ value: z.string(), label: z.string(), checked: z.boolean().optional() }), description: 'Checkbox option.', component: Unknown });
const CheckBoxGroupComponent = defineComponent({ name: 'CheckBoxGroup', props: z.object({ name: z.string(), items: anyArray, rules: anyObject }), description: 'Checkbox group.', component: CheckBoxGroup });
const RadioItemComponent = defineComponent({ name: 'RadioItem', props: z.object({ value: z.string(), label: z.string() }), description: 'Radio option.', component: Unknown });
const RadioGroupComponent = defineComponent({ name: 'RadioGroup', props: z.object({ name: z.string(), items: anyArray, rules: anyObject }), description: 'Radio group.', component: RadioGroup });
const SwitchItemComponent = defineComponent({ name: 'SwitchItem', props: z.object({ value: z.string().optional(), name: z.string().optional(), label: z.string() }), description: 'Switch option.', component: Unknown });
const SwitchGroupComponent = defineComponent({ name: 'SwitchGroup', props: z.object({ name: z.string(), items: anyArray, rules: anyObject }), description: 'Switch group.', component: SwitchGroup });
const TabItemComponent = defineComponent({ name: 'TabItem', props: z.object({ value: z.string(), trigger: z.string(), content: anyArray }), description: 'Tab descriptor.', component: Unknown });
const TabsComponent = defineComponent({ name: 'Tabs', props: z.object({ items: anyArray }), description: 'Tabbed content layout.', component: Tabs });
const AccordionItemComponent = defineComponent({ name: 'AccordionItem', props: z.object({ value: z.string(), trigger: z.string(), content: anyArray }), description: 'Accordion section.', component: Unknown });
const AccordionComponent = defineComponent({ name: 'Accordion', props: z.object({ items: anyArray }), description: 'Accordion layout.', component: Accordion });
const StepsItemComponent = defineComponent({ name: 'StepsItem', props: z.object({ title: z.string(), content: anyArray }), description: 'Step definition.', component: Unknown });
const StepsComponent = defineComponent({ name: 'Steps', props: z.object({ items: anyArray }), description: 'Step-by-step layout.', component: Steps });
const CarouselComponent = defineComponent({ name: 'Carousel', props: z.object({ slides: anyArray, variant: z.string().optional() }), description: 'Carousel of slides.', component: Carousel });
const SeparatorComponent = defineComponent({ name: 'Separator', props: z.object({ orientation: z.string().optional() }), description: 'Visual divider.', component: Separator });
const ListItemComponent = defineComponent({ name: 'ListItem', props: z.object({ text: z.string(), description: z.string().optional() }), description: 'Clickable list option.', component: Unknown });
const ListBlockComponent = defineComponent({ name: 'ListBlock', props: z.object({ items: anyArray }), description: 'List of follow-up actions.', component: ListBlock });
const FollowUpItemComponent = defineComponent({ name: 'FollowUpItem', props: z.object({ text: z.string() }), description: 'Follow-up suggestion.', component: Unknown });
const FollowUpBlockComponent = defineComponent({ name: 'FollowUpBlock', props: z.object({ items: anyArray }), description: 'Follow-up suggestion buttons.', component: FollowUpBlock });
const SectionItemComponent = defineComponent({ name: 'SectionItem', props: z.object({ value: z.string(), trigger: z.string(), content: anyArray }), description: 'Section definition.', component: Unknown });
const SectionBlockComponent = defineComponent({ name: 'SectionBlock', props: z.object({ items: anyArray, isFoldable: z.boolean().optional() }), description: 'Collapsible sections.', component: SectionBlock });
const SeriesComponent = defineComponent({ name: 'Series', props: z.object({ label: z.string(), data: anyArray }), description: 'Chart data series.', component: Unknown });
const SliceComponent = defineComponent({ name: 'Slice', props: z.object({ label: z.string(), value: z.number() }), description: 'Pie or radial slice.', component: Unknown });
const PointComponent = defineComponent({ name: 'Point', props: z.object({ x: z.number(), y: z.number(), label: z.string().optional() }), description: 'Scatter point.', component: Unknown });
const ScatterSeriesComponent = defineComponent({ name: 'ScatterSeries', props: z.object({ label: z.string(), points: anyArray }), description: 'Scatter series.', component: Unknown });

const chartComponents = [
  defineComponent({ name: 'BarChart', props: z.object({ labels: anyArray, series: anyArray, variant: z.string().optional(), title: z.string().optional() }), description: 'Bar chart.', component: Chart }),
  defineComponent({ name: 'LineChart', props: z.object({ labels: anyArray, series: anyArray, variant: z.string().optional(), title: z.string().optional() }), description: 'Line chart.', component: Chart }),
  defineComponent({ name: 'AreaChart', props: z.object({ labels: anyArray, series: anyArray, variant: z.string().optional(), title: z.string().optional() }), description: 'Area chart.', component: Chart }),
  defineComponent({ name: 'RadarChart', props: z.object({ labels: anyArray, series: anyArray, title: z.string().optional() }), description: 'Radar chart.', component: Chart }),
  defineComponent({ name: 'HorizontalBarChart', props: z.object({ labels: anyArray, series: anyArray, title: z.string().optional() }), description: 'Horizontal bar chart.', component: Chart }),
  defineComponent({ name: 'PieChart', props: z.object({ slices: anyArray, title: z.string().optional() }), description: 'Pie chart.', component: Chart }),
  defineComponent({ name: 'RadialChart', props: z.object({ slices: anyArray, title: z.string().optional() }), description: 'Radial chart.', component: Chart }),
  defineComponent({ name: 'SingleStackedBarChart', props: z.object({ labels: anyArray, series: anyArray, title: z.string().optional() }), description: 'Stacked bar chart.', component: Chart }),
  defineComponent({ name: 'ScatterChart', props: z.object({ series: anyArray, title: z.string().optional() }), description: 'Scatter chart.', component: Chart })
];

const sharedComponents = [
  CardHeaderComponent,
  TextContentComponent,
  MarkdownComponent,
  CalloutComponent,
  TextCalloutComponent,
  ImageComponent,
  ImageBlockComponent,
  ImageGalleryComponent,
  CodeBlockComponent,
  TableComponent,
  ColComponent,
  ...chartComponents,
  SeriesComponent,
  SliceComponent,
  PointComponent,
  ScatterSeriesComponent,
  FormComponent,
  FormControlComponent,
  LabelComponent,
  InputComponent,
  TextAreaComponent,
  SelectComponent,
  SelectItemComponent,
  DatePickerComponent,
  SliderComponent,
  CheckBoxGroupComponent,
  CheckBoxItemComponent,
  RadioGroupComponent,
  RadioItemComponent,
  SwitchGroupComponent,
  SwitchItemComponent,
  ButtonComponent,
  ButtonsComponent,
  TabsComponent,
  TabItemComponent,
  AccordionComponent,
  AccordionItemComponent,
  StepsComponent,
  StepsItemComponent,
  CarouselComponent,
  SeparatorComponent,
  TagBlockComponent,
  TagComponent
];

const uiComponentGroups: ComponentGroup[] = [
  { name: 'Layout', components: ['Stack', 'Tabs', 'TabItem', 'Accordion', 'AccordionItem', 'Steps', 'StepsItem', 'Carousel', 'Separator'] },
  { name: 'Content', components: ['Card', 'CardHeader', 'TextContent', 'MarkDownRenderer', 'Callout', 'TextCallout', 'Image', 'ImageBlock', 'ImageGallery', 'CodeBlock'] },
  { name: 'Tables', components: ['Table', 'Col'] },
  { name: 'Charts', components: ['BarChart', 'LineChart', 'AreaChart', 'RadarChart', 'HorizontalBarChart', 'PieChart', 'RadialChart', 'SingleStackedBarChart', 'ScatterChart', 'Series', 'Slice', 'ScatterSeries', 'Point'] },
  { name: 'Forms', components: ['Form', 'FormControl', 'Label', 'Input', 'TextArea', 'Select', 'SelectItem', 'DatePicker', 'Slider', 'CheckBoxGroup', 'CheckBoxItem', 'RadioGroup', 'RadioItem', 'SwitchGroup', 'SwitchItem'] },
  { name: 'Buttons', components: ['Button', 'Buttons'] },
  { name: 'Data Display', components: ['TagBlock', 'Tag'] }
];

const uiChatComponentGroups: ComponentGroup[] = [
  ...uiComponentGroups,
  { name: 'Lists & Follow-ups', components: ['ListBlock', 'ListItem', 'FollowUpBlock', 'FollowUpItem'] },
  { name: 'Sections', components: ['SectionBlock', 'SectionItem'] }
];

const uiPromptOptions: PromptOptions = {
  additionalRules: [
    'Use Stack for general layouts and Card for grouped panels.',
    'Define referenced variables before or after use; root must always be present.',
    'For forms, pass Form(name, buttons, fields).'
  ]
};

const uiChatPromptOptions: PromptOptions = {
  additionalRules: [
    'Use Card as the root component for chat responses.',
    'Use FollowUpBlock at the end when suggesting next actions.',
    'Use ListBlock for clickable options and SectionBlock for grouped details.'
  ]
};

const uiLibrary = createLibrary({
  root: 'Stack',
  componentGroups: uiComponentGroups,
  components: [StackComponent, CardComponent, ...sharedComponents]
});

export const uiChatLibrary = createLibrary({
  root: 'Card',
  componentGroups: uiChatComponentGroups,
  components: [
    defineComponent({ name: 'Card', props: z.object({ children: anyArray }), description: 'Vertical chat content container.', component: ChatCard }),
    ...sharedComponents,
    ListBlockComponent,
    ListItemComponent,
    FollowUpBlockComponent,
    FollowUpItemComponent,
    SectionBlockComponent,
    SectionItemComponent
  ]
});
