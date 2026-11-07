<script>
	export default {
		onLaunch: function() {
		},
		onShow: function() {
		},
		onHide: function() {
		}
	}
</script>

<style lang="scss">
	/*每个页面公共css */
	@import '@/uni_modules/uni-scss/index.scss';
	/* #ifndef APP-NVUE */
	@import '@/static/customicons.css';
		@import '@/static/styles/silver-frost.scss';
	/* H5 tab bars sit above uni-popup's legacy default z-index. Dialogs must cover them. */
	.uni-popup { z-index: 1100 !important; }
	/* Filters and confirmations opened from a sheet must remain above that sheet. */
	.uni-picker-container { z-index: 1200 !important; }
	uni-modal, uni-toast { z-index: 1300 !important; }
	/* uni-app's default transition preloads a remote decorative image. Keep the private app offline. */
	body::after { animation: none !important; background-image: none !important; }

	/* #endif */
	.example-info {
		font-size: 14px;
		color: #333;
		padding: 10px;
	}
</style>
