const SKILL_TERMS = [
  '嵌入式', '单片机', 'STM32', 'ARM', 'Cortex', 'MCU', 'MPU', 'DSP', 'FPGA', 'RTOS', 'FreeRTOS', 'ucos',
  'Linux', 'Uboot', 'Bootloader', '内核', '驱动', '设备树', '文件系统', '系统移植', '交叉编译',
  'C语言', 'C++', 'C#', 'Python', 'Shell', 'Qt', 'LVGL', 'GUI',
  'UART', 'USART', 'SPI', 'I2C', 'CAN', 'RS232', 'RS485', 'Modbus', '以太网', 'TCP/IP', 'MQTT',
  '蓝牙', 'BLE', 'WiFi', 'Zigbee', 'LoRa', 'NB-IoT', '4G', '5G', '物联网', 'OTA', '低功耗',
  'ADC', 'PWM', 'DMA', '中断', '定时器', 'Flash', 'EEPROM', '传感器', '编码器', '电机', '伺服', '运动控制',
  '原理图', 'PCB', '电路', '硬件', '示波器', '万用表', '焊接', '调试', '仿真', 'EMC',
  '机器视觉', 'OpenCV', 'Halcon', '图像', '算法', '深度学习', '神经网络',
  'Autosar', 'VCU', 'BCM', '智能座舱', '自动驾驶', '车规', '功能安全', 'ISO26262',
  '测试', '单元测试', '集成测试', '功能测试', '可靠性测试', 'EMC测试',
];

const LEVEL_TERMS = ['本科', '硕士', '博士', '大专', '应届', '1-3年', '3-5年', '5-10年', '10年以上'];

const AI_TONE_MAP = [
  [/赋能/g, '支持'],
  [/闭环了整个/g, '走通了整个'],
  [/闭环/g, '走通'],
  [/抓手/g, '切入点'],
  [/底层逻辑/g, '原理'],
  [/颗粒度/g, '细节'],
  [/对齐/g, '沟通一致'],
  [/组合拳/g, '多种手段'],
  [/护城河/g, '优势'],
  [/生态位/g, '定位'],
  [/深度参与/g, '参与'],
  [/深耕/g, '长期做'],
  [/全方位/g, '全面'],
  [/极致/g, '很高'],
  [/显著提升/g, '提升'],
  [/大幅提升/g, '提升'],
  [/极大/g, '较大'],
  [/深入浅出/g, '讲得通俗'],
  [/助力/g, '帮助'],
  [/秉承/g, '坚持'],
  [/致力于/g, '专注于'],
  [/打造/g, '做出'],
  [/沉淀/g, '积累'],
  [/跃迁/g, '提升'],
  [/痛点/g, '问题'],
  [/发力/g, '投入'],
  [/协同/g, '配合'],
  [/洞察/g, '判断'],
  [/纵深/g, '更深'],
  [/破局/g, '解决'],
  [/抓手/g, '切入点'],
  [/一方面/g, ''],
  [/另一方面/g, ''],
];

const BULLET_START_MAP = [
  [/^负责/g, '负责'],
  [/^参与了/g, '参与'],
  [/^参与/g, '参与'],
  [/^从事/g, '负责'],
  [/^主要/g, ''],
];

function normalize(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function findTerms(text, dict = SKILL_TERMS) {
  const hay = String(text ?? '');
  const lower = hay.toLowerCase();
  return dict.filter((term) => lower.includes(term.toLowerCase()));
}

function extractAll(text) {
  const skills = findTerms(text);
  const levels = findTerms(text, LEVEL_TERMS);
  return { skills, levels };
}

module.exports = { SKILL_TERMS, LEVEL_TERMS, AI_TONE_MAP, BULLET_START_MAP, normalize, findTerms, extractAll };
