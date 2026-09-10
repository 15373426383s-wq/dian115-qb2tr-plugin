package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"unsafe"
)

//go:wasmimport dian115 host_call
func hostCall(ptr, length int32) int32

//go:wasmimport dian115 host_read
func hostRead(ptr, length int32) int32

var memory []byte

// PluginConfig 插件配置（内存持久化，worker 重启后需重新保存）
type PluginConfig struct {
	QBUrl        string `json:"qb_url"`
	QBSID        string `json:"qb_sid"`
	TRUrl        string `json:"tr_url"`
	TRUsername   string `json:"tr_username"`
	TRPassword   string `json:"tr_password"`
	DeleteFromQB bool   `json:"delete_from_qb"`
}

var currentConfig = PluginConfig{
	QBUrl: "http://qb:8080",
	TRUrl: "http://tr:9091/transmission/rpc",
}

func main() {}

//go:wasmexport dian115_alloc
func dian115_alloc(size int32) int32 {
	memory = make([]byte, size)
	if len(memory) == 0 {
		return 0
	}
	return int32(uintptr(unsafe.Pointer(&memory[0])))
}

//go:wasmexport dian115_handle
func dian115_handle(ptr, length int32) int64 {
	request := readMemory(ptr, length)
	var envelope map[string]interface{}
	if err := json.Unmarshal(request, &envelope); err != nil {
		return respondError(-32700, "parse error")
	}

	params, _ := envelope["params"].(map[string]interface{})
	if params == nil {
		return respondError(-32602, "invalid params")
	}
	innerEnvelope, _ := params["envelope"].(map[string]interface{})
	if innerEnvelope == nil {
		return respondError(-32602, "invalid envelope")
	}

	op, _ := innerEnvelope["op"].(string)

	switch op {
	case "state":
		return respond(map[string]interface{}{
			"state_version": "1",
			"data":          getPluginState(),
		})
	case "action":
		payload, _ := innerEnvelope["payload"].(map[string]interface{})
		return respond(handleAction(payload))
	case "job":
		// 定时 job 只允许 accepted / skipped
		runTransferWithConfig(currentConfig)
		return respond(map[string]interface{}{"status": "accepted"})
	default:
		return respondError(-32601, "unknown op")
	}
}

func readMemory(ptr, length int32) []byte {
	buf := make([]byte, length)
	src := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), length)
	copy(buf, src)
	return buf
}

func respond(data map[string]interface{}) int64 {
	respBytes, _ := json.Marshal(map[string]interface{}{
		"status": "succeeded",
		"data":   data,
	})
	return writeResponse(respBytes)
}

func respondError(code int, message string) int64 {
	respBytes, _ := json.Marshal(map[string]interface{}{
		"status": "failed",
		"error":  map[string]interface{}{"code": code, "message": message},
	})
	return writeResponse(respBytes)
}

func writeResponse(respBytes []byte) int64 {
	if len(respBytes) == 0 {
		return 0
	}
	ptr := dian115_alloc(int32(len(respBytes)))
	copy(unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), len(respBytes)), respBytes)
	return (int64(ptr) << 32) | int64(len(respBytes))
}

func getPluginState() map[string]interface{} {
	// 不返回密码明文，只返回是否已配置
	cfg := currentConfig
	cfg.TRPassword = ""
	if cfg.TRPassword != "" {
		cfg.TRPassword = "***"
	}
	return map[string]interface{}{"config": cfg}
}

func handleAction(payload map[string]interface{}) map[string]interface{} {
	action, _ := payload["action"].(string)
	switch action {
	case "transfer_now":
		cfg := mergeConfig(currentConfig, payload)
		return runTransferWithConfig(cfg)
	case "save_config":
		currentConfig = mergeConfig(currentConfig, payload)
		return map[string]interface{}{"status": "saved"}
	default:
		return map[string]interface{}{"status": "failed", "error": "unknown action: " + action}
	}
}

func mergeConfig(base PluginConfig, payload map[string]interface{}) PluginConfig {
	configMap, ok := payload["config"].(map[string]interface{})
	if !ok {
		return base
	}
	if v, ok := configMap["qb_url"].(string); ok && v != "" {
		base.QBUrl = strings.TrimRight(v, "/")
	}
	if v, ok := configMap["qb_sid"].(string); ok {
		base.QBSID = v
	}
	if v, ok := configMap["tr_url"].(string); ok && v != "" {
		base.TRUrl = v
	}
	if v, ok := configMap["tr_username"].(string); ok {
		base.TRUsername = v
	}
	if v, ok := configMap["tr_password"].(string); ok {
		base.TRPassword = v
	}
	if v, ok := configMap["delete_from_qb"].(bool); ok {
		base.DeleteFromQB = v
	}
	return base
}

func runTransferWithConfig(cfg PluginConfig) map[string]interface{} {
	// 1. 获取 qB 已完成任务
	qbHeaders := map[string]string{}
	if cfg.QBSID != "" {
		qbHeaders["Cookie"] = "SID=" + cfg.QBSID
	}
	infoResp, err := callHost("GET", cfg.QBUrl+"/api/v2/torrents/info?filter=completed", qbHeaders, nil)
	if err != nil {
		return map[string]interface{}{"status": "failed", "error": "无法连接 qBittorrent: " + err.Error()}
	}
	if infoResp.Status == 403 || infoResp.Status == 401 {
		return map[string]interface{}{"status": "failed", "error": fmt.Sprintf("qBittorrent 认证失败（状态码 %d）。请在 qB WebUI 设置中开启「Bypass authentication for clients in whitelisted IP subnets」并加入 DIAN115 容器网段，或在插件中填写 SID", infoResp.Status)}
	}
	if infoResp.Status != 200 {
		return map[string]interface{}{"status": "failed", "error": fmt.Sprintf("qBittorrent 返回状态码 %d", infoResp.Status)}
	}

	var torrents []map[string]interface{}
	bodyBytes, _ := base64.StdEncoding.DecodeString(infoResp.BodyB64)
	if err := json.Unmarshal(bodyBytes, &torrents); err != nil {
		return map[string]interface{}{"status": "failed", "error": "解析 qBittorrent 响应失败"}
	}
	if len(torrents) == 0 {
		return map[string]interface{}{"status": "succeeded", "total": 0, "success": 0, "failed": 0, "skipped": 0, "message": "qB 中没有已完成的任务"}
	}

	// 2. 获取 TR session-id
	trHeaders := map[string]string{}
	if cfg.TRUsername != "" {
		trHeaders["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(cfg.TRUsername+":"+cfg.TRPassword))
	}
	trResp, err := callHost("GET", cfg.TRUrl, trHeaders, nil)
	if err != nil {
		return map[string]interface{}{"status": "failed", "error": "无法连接 Transmission: " + err.Error()}
	}
	trSession := extractHeader(trResp.Headers, "x-transmission-session-id")
	if trSession == "" {
		return map[string]interface{}{"status": "failed", "error": fmt.Sprintf("无法获取 Transmission session-id（状态码 %d，请检查地址和认证）", trResp.Status)}
	}
	trHeaders["X-Transmission-Session-Id"] = trSession

	// 3. 逐个添加到 TR
	success, failed, skipped := 0, 0, 0
	var failedNames []string

	for _, t := range torrents {
		hash, _ := t["hash"].(string)
		name, _ := t["name"].(string)
		savePath, _ := t["save_path"].(string)
		state, _ := t["state"].(string)

		// 只处理已完成的种子（uploading/stalledUP/pausedUP/queuedUP/forcedUP）
		if !strings.HasSuffix(state, "UP") {
			skipped++
			continue
		}

		magnet := fmt.Sprintf("magnet:?xt=urn:btih:%s&dn=%s", hash, url.QueryEscape(name))
		trBody, _ := json.Marshal(map[string]interface{}{
			"method": "torrent-add",
			"arguments": map[string]interface{}{
				"filename":     magnet,
				"download-dir": savePath,
				"paused":       false,
			},
		})

		addResp, err := callHost("POST", cfg.TRUrl, trHeaders, trBody)
		if err != nil {
			failed++
			failedNames = append(failedNames, name)
			continue
		}

		addBody, _ := base64.StdEncoding.DecodeString(addResp.BodyB64)
		var trResult map[string]interface{}
		json.Unmarshal(addBody, &trResult)

		if trResult["result"] == "success" {
			success++
			if cfg.DeleteFromQB {
				delBody := []byte("hashes=" + hash + "&deleteFiles=false")
				callHost("POST", cfg.QBUrl+"/api/v2/torrents/delete", qbHeaders, delBody)
			}
		} else {
			failed++
			failedNames = append(failedNames, name)
		}
	}

	result := map[string]interface{}{
		"status":  "succeeded",
		"total":   len(torrents),
		"success": success,
		"failed":  failed,
		"skipped": skipped,
	}
	if len(failedNames) > 0 {
		result["failed_names"] = failedNames
	}
	return result
}

type HostCallRequest struct {
	Jsonrpc string                 `json:"jsonrpc"`
	ID      string                 `json:"id"`
	Method  string                 `json:"method"`
	Params  map[string]interface{} `json:"params"`
}

type HostCallResponse struct {
	Status  int                 `json:"status"`
	Headers map[string][]string `json:"headers"`
	BodyB64 string              `json:"body_base64"`
}

func callHost(method, path string, headers map[string]string, body []byte) (*HostCallResponse, error) {
	params := map[string]interface{}{"method": method, "path": path}
	if len(headers) > 0 {
		params["headers"] = headers
	}
	if body != nil {
		params["body_base64"] = base64.StdEncoding.EncodeToString(body)
	}

	req := HostCallRequest{Jsonrpc: "2.0", ID: "p:call:1", Method: "host.call", Params: params}
	reqBytes, _ := json.Marshal(req)
	reqPtr := dian115_alloc(int32(len(reqBytes)))
	copy(unsafe.Slice((*byte)(unsafe.Pointer(uintptr(reqPtr))), len(reqBytes)), reqBytes)

	respLen := hostCall(reqPtr, int32(len(reqBytes)))
	if respLen <= 0 {
		return nil, fmt.Errorf("host.call 返回空响应")
	}
	respBuf := make([]byte, respLen)
	hostRead(int32(uintptr(unsafe.Pointer(&respBuf[0]))), respLen)

	var resp HostCallResponse
	if err := json.Unmarshal(respBuf, &resp); err != nil {
		return nil, fmt.Errorf("解析 host.call 响应失败: %v", err)
	}
	return &resp, nil
}

func extractHeader(headers map[string][]string, key string) string {
	keyLower := strings.ToLower(key)
	for k, v := range headers {
		if strings.ToLower(k) == keyLower {
			if len(v) > 0 {
				return v[0]
			}
		}
	}
	return ""
}
