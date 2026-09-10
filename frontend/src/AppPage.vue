<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  NCard, NForm, NFormItem, NInput, NButton, NCheckbox,
  NSpace, NAlert, NSpin, NDivider, NThing, NStatistic, NGrid, NGi
} from 'naive-ui'
import { Save, Play, HardDriveDownload, Server } from '@lucide/vue'

interface PluginHostBridge {
  getState(view?: string): Promise<{ state_version?: string; state?: Record<string, unknown> }>
  invokeAction(action: string, input?: unknown): Promise<{ result?: { status: string; [key: string]: unknown } }>
  refresh(): Promise<Record<string, unknown>>
}

const props = defineProps<{
  api: PluginHostBridge
  runtimeState?: Record<string, unknown>
}>()

const config = ref({
  qb_url: 'http://qb:8080',
  qb_sid: '',
  tr_url: 'http://tr:9091/transmission/rpc',
  tr_username: '',
  tr_password: '',
  delete_from_qb: false,
})

const saving = ref(false)
const transferring = ref(false)
const result = ref<null | { status: string; message?: string; total?: number; success?: number; failed?: number; skipped?: number; failed_names?: string[] }>(null)
const errorMsg = ref('')

onMounted(async () => {
  try {
    const resp = await props.api.getState()
    const cfg = resp?.state?.config as Record<string, unknown> | undefined
    if (cfg) {
      if (typeof cfg.qb_url === 'string') config.value.qb_url = cfg.qb_url
      if (typeof cfg.qb_sid === 'string') config.value.qb_sid = cfg.qb_sid
      if (typeof cfg.tr_url === 'string') config.value.tr_url = cfg.tr_url
      if (typeof cfg.tr_username === 'string') config.value.tr_username = cfg.tr_username
      if (typeof cfg.delete_from_qb === 'boolean') config.value.delete_from_qb = cfg.delete_from_qb
    }
  } catch {
    // 忽略 state 读取失败，使用默认值
  }
})

async function saveConfig() {
  saving.value = true
  errorMsg.value = ''
  try {
    const resp = await props.api.invokeAction('save_config', { config: config.value })
    if (resp.result?.status === 'succeeded' || resp.result?.status === 'saved') {
      result.value = { status: 'saved', message: '配置已保存到运行时（worker 重启后需重新保存）' }
    } else {
      errorMsg.value = String(resp.result?.message || '保存失败')
    }
  } catch (e: any) {
    errorMsg.value = String(e?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function transferNow() {
  transferring.value = true
  errorMsg.value = ''
  result.value = null
  try {
    const resp = await props.api.invokeAction('transfer_now', { config: config.value })
    const r = resp.result as any
    if (r?.status === 'failed') {
      errorMsg.value = String(r.error || r.message || '转移失败')
    } else {
      result.value = {
        status: 'succeeded',
        total: r.total,
        success: r.success,
        failed: r.failed,
        skipped: r.skipped,
        failed_names: r.failed_names,
        message: r.message,
      }
    }
  } catch (e: any) {
    errorMsg.value = String(e?.message || '转移请求失败')
  } finally {
    transferring.value = false
  }
}
</script>

<template>
  <main class="dian-plugin-page" style="padding: 16px; box-sizing: border-box; width: 100%;">
    <NSpin :show="transferring">
      <NSpace vertical :size="16">
        <NThing>
          <template #header>
            <span style="font-size: 18px; font-weight: 600; color: var(--dian-text-primary);">
              QB → TR 自动转移做种
            </span>
          </template>
          <template #description>
            <span style="color: var(--dian-text-secondary);">
              将 qBittorrent 中已完成的任务转移到 Transmission 继续做种
            </span>
          </template>
        </NThing>

        <NAlert type="info" :show-icon="true" style="background: var(--dian-surface-soft); border-color: var(--dian-border);">
          <template #header>qB 认证说明</template>
          DIAN115 会删除 HTTP 响应的 Set-Cookie，因此无法自动登录 qB。请二选一：
          <b>①</b> 在 qB WebUI 设置中开启「Bypass authentication for clients in whitelisted IP subnets」，加入 DIAN115 容器网段（SID 留空）；
          <b>②</b> 从浏览器 F12 → Application → Cookies 复制 SID 值填入下方。
        </NAlert>

        <NCard size="small" style="background: var(--dian-surface-raised); border-color: var(--dian-border);">
          <template #header>
            <NSpace align="center">
              <Server :size="16" />
              <span style="font-weight: 600;">qBittorrent</span>
            </NSpace>
          </template>
          <NForm label-placement="top" label-style="color: var(--dian-text-secondary);">
            <NFormItem label="qB 地址">
              <NInput v-model:value="config.qb_url" placeholder="http://qb:8080" />
            </NFormItem>
            <NFormItem label="qB SID（白名单模式可留空）">
              <NInput v-model:value="config.qb_sid" placeholder="从浏览器 Cookie 复制 SID 值" />
            </NFormItem>
          </NForm>
        </NCard>

        <NCard size="small" style="background: var(--dian-surface-raised); border-color: var(--dian-border);">
          <template #header>
            <NSpace align="center">
              <HardDriveDownload :size="16" />
              <span style="font-weight: 600;">Transmission</span>
            </NSpace>
          </template>
          <NForm label-placement="top" label-style="color: var(--dian-text-secondary);">
            <NFormItem label="TR RPC 地址">
              <NInput v-model:value="config.tr_url" placeholder="http://tr:9091/transmission/rpc" />
            </NFormItem>
            <NFormItem label="TR 用户名（无认证可留空）">
              <NInput v-model:value="config.tr_username" placeholder="用户名" />
            </NFormItem>
            <NFormItem label="TR 密码">
              <NInput v-model:value="config.tr_password" type="password" show-password-on="click" placeholder="密码" />
            </NFormItem>
          </NForm>
        </NCard>

        <NCheckbox v-model:checked="config.delete_from_qb">
          转移成功后从 qB 删除原任务（不删除文件）
        </NCheckbox>

        <NSpace>
          <NButton type="primary" :loading="saving" @click="saveConfig">
            <template #icon><Save :size="16" /></template>
            保存配置
          </NButton>
          <NButton type="success" :loading="transferring" @click="transferNow">
            <template #icon><Play :size="16" /></template>
            立即转移
          </NButton>
        </NSpace>

        <NAlert v-if="errorMsg" type="error" :show-icon="true" style="background: var(--dian-surface-soft);">
          {{ errorMsg }}
        </NAlert>

        <NCard v-if="result" size="small" style="background: var(--dian-surface-raised); border-color: var(--dian-border);">
          <template #header>转移结果</template>
          <template v-if="result.status === 'saved'">
            <NAlert type="success" :show-icon="false">{{ result.message }}</NAlert>
          </template>
          <template v-else>
            <NGrid :cols="4" :x-gap="12" responsive="screen" style="margin-bottom: 12px;">
              <NGi><NStatistic label="qB 已完成总数" :value="result.total ?? 0" /></NGi>
              <NGi><NStatistic label="转移成功" :value="result.success ?? 0" style="color: var(--dian-success);" /></NGi>
              <NGi><NStatistic label="转移失败" :value="result.failed ?? 0" style="color: var(--dian-error);" /></NGi>
              <NGi><NStatistic label="跳过" :value="result.skipped ?? 0" /></NGi>
            </NGrid>
            <div v-if="result.message" style="color: var(--dian-text-secondary); margin-bottom: 8px;">{{ result.message }}</div>
            <div v-if="result.failed_names && result.failed_names.length > 0" style="color: var(--dian-error); font-size: 13px;">
              失败任务：{{ result.failed_names.join('、') }}
            </div>
          </template>
        </NCard>
      </NSpace>
    </NSpin>
  </main>
</template>

<style scoped>
.dian-plugin-page {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  color: var(--dian-text-primary);
  font-family: var(--dian-font-family);
}
</style>
